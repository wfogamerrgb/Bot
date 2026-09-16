'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// The Apps Script endpoint is the other half of /data, and the failure mode that
// used to bite was silent: a bad payload threw mid-write (leaving stale sheets)
// or a non-public deployment answered with an HTML login page while the bot
// logged a successful push. These tests run the real Code.gs against fake Apps
// Script services so that contract stays pinned down.
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'google-apps-script', 'Code.gs'), 'utf8')
const SPREADSHEET_ID = 'spreadsheet-under-test'

function makeSheet (name, { failWrites = false } = {}) {
  const rows = []
  return {
    name,
    rows,
    getName: () => name,
    clearContents: () => { rows.length = 0 },
    setFrozenRows: () => {},
    getLastRow: () => rows.length,
    getLastColumn: () => rows.reduce((max, row) => Math.max(max, row.length), 0),
    getRange (row, col, numRows = 1, numCols = 1) {
      return {
        setValues (values) {
          if (failWrites) throw new Error('cannot write to ' + name)
          values.forEach((line, i) => {
            const at = row - 1 + i
            rows[at] = rows[at] || []
            line.forEach((value, j) => { rows[at][col - 1 + j] = value })
          })
          return this
        },
        getValues () {
          const out = []
          for (let i = 0; i < numRows; i++) {
            const at = row - 1 + i
            out.push(Array.from({ length: numCols }, (_, j) => (rows[at] && rows[at][col - 1 + j] !== undefined ? rows[at][col - 1 + j] : '')))
          }
          return out
        }
      }
    }
  }
}

// Runs Code.gs in a fresh VM context with fake Apps Script globals.
function run ({ properties = { SPREADSHEET_ID }, failWrites = [] } = {}) {
  const sheets = new Map()
  const logged = []
  const spreadsheet = {
    getSheets: () => Array.from(sheets.values()),
    getSheetByName: (name) => sheets.get(name) || null,
    insertSheet: (name) => {
      const sheet = makeSheet(name, { failWrites: failWrites.includes(name) })
      sheets.set(name, sheet)
      return sheet
    }
  }
  const sandbox = {
    SpreadsheetApp: {
      openById: (id) => {
        if (id !== SPREADSHEET_ID) throw new Error('No permission to open ' + id)
        return spreadsheet
      }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (key in properties ? properties[key] : null),
        setProperty: (key, value) => { properties[key] = value }
      })
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({
        setMimeType () { return this },
        getContent () { return text }
      })
    },
    Logger: { log: (message) => logged.push(String(message)) },
    console
  }
  vm.createContext(sandbox)
  new vm.Script(SOURCE, { filename: 'Code.gs' }).runInContext(sandbox)
  return {
    sandbox,
    properties,
    logged,
    sheet: (name) => sheets.get(name),
    post: (body, extra = {}) => JSON.parse(sandbox.doPost({
      parameter: extra.parameter || {},
      postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) }
    }).getContent())
  }
}

const payload = {
  bots: [
    { bot: 'BotA', rank: 'Member', balance: 12.5, botPosition: { x: 1, y: 64, z: -3 }, spawnerCount: 2 },
    { bot: 'BotB', rank: 'Regent', balance: 8, botPosition: { x: 4, y: 65, z: 9 }, spawnerCount: 0 }
  ],
  spawners: [
    { bot: 'BotA', spawnerNumber: 1, earned: 100, ratePerHour: 1200, status: 'calculated' }
  ],
  lifetime: { totalEarned: 100, samples: 1 },
  generatedAt: '2026-01-01T00:00:00.000Z'
}

test('doGet reports a health check without writing anything', () => {
  const { sandbox, sheet } = run()
  const health = JSON.parse(sandbox.doGet().getContent())
  assert.equal(health.ok, true)
  assert.equal(health.spreadsheetId, SPREADSHEET_ID)
  assert.equal(health.secretRequired, false)
  assert.equal(sheet('Bots'), undefined, 'a health check must not create sheets')
})

test('doGet reports a spreadsheet that cannot be opened', () => {
  const { sandbox } = run({ properties: { SPREADSHEET_ID: 'other-id' } })
  const health = JSON.parse(sandbox.doGet().getContent())
  assert.equal(health.ok, false)
  assert.match(health.spreadsheetError, /No permission to open/)
})

test('doPost replaces Bots, Spawners, and Lifetime and reports row counts', () => {
  const { sandbox, sheet, post } = run()
  const result = post(payload)
  assert.equal(result.ok, true)
  assert.deepEqual(result.written, { Bots: 2, Spawners: 1, Lifetime: 1 })
  assert.equal(result.generatedAt, '2026-01-01T00:00:00.000Z')
  assert.deepEqual(sheet('Bots').rows[0], ['bot', 'rank', 'balance', 'botPosition', 'spawnerCount'])
  assert.deepEqual(sheet('Bots').rows[1], ['BotA', 'Member', 12.5, '{"x":1,"y":64,"z":-3}', 2])
  assert.deepEqual(sheet('Lifetime').rows[1], [100, 1])
})

test('doPost uses the union of every row key so uneven rows still write', () => {
  const { sheet, post } = run()
  const result = post({
    bots: [{ bot: 'BotA', rank: 'Member' }, { bot: 'BotB', balance: 5 }],
    spawners: [],
    lifetime: { totalEarned: 0, samples: 0 }
  })
  assert.equal(result.ok, true)
  assert.deepEqual(sheet('Bots').rows[0], ['bot', 'rank', 'balance'])
  assert.deepEqual(sheet('Bots').rows[1], ['BotA', 'Member', ''])
  assert.deepEqual(sheet('Bots').rows[2], ['BotB', '', 5])
})

test('doPost survives an empty Lifetime object (the old code threw here)', () => {
  const { sheet, post } = run()
  const result = post({ bots: [{ bot: 'BotA' }], spawners: [], lifetime: {} })
  assert.equal(result.ok, true)
  assert.deepEqual(result.written, { Bots: 1, Spawners: 0, Lifetime: 0 })
  assert.deepEqual(sheet('Bots').rows[1], ['BotA'])
  assert.deepEqual(sheet('Lifetime').rows, [], 'an empty lifetime clears the tab instead of failing')
})

test('doPost overwrites stale rows instead of appending forever', () => {
  const { sheet, post } = run()
  post({ bots: [{ bot: 'BotA' }, { bot: 'BotB' }], spawners: [], lifetime: { totalEarned: 0, samples: 0 } })
  post({ bots: [{ bot: 'BotA' }], spawners: [], lifetime: { totalEarned: 0, samples: 0 } })
  assert.equal(sheet('Bots').rows.length, 2, 'header + one data row')
})

test('doPost truncates oversized cells instead of failing the write', () => {
  const { sheet, post } = run()
  const huge = 'x'.repeat(60000)
  const result = post({ bots: [{ bot: 'BotA', note: huge }], spawners: [], lifetime: { totalEarned: 0, samples: 0 } })
  assert.equal(result.ok, true)
  const written = String(sheet('Bots').rows[1][1])
  assert.ok(written.length < 50000, 'cell stays inside the Apps Script limit')
  assert.ok(written.endsWith('…'))
})

test('doPost explains a missing SPREADSHEET_ID', () => {
  const { post } = run({ properties: {} })
  const result = post(payload)
  assert.equal(result.ok, false)
  assert.match(result.errors[0], /SPREADSHEET_ID is not set/)
})

test('doPost explains a request with no payload (Run button in the editor)', () => {
  const { sandbox } = run()
  const result = JSON.parse(sandbox.doPost({}).getContent())
  assert.equal(result.ok, false)
  assert.match(result.errors[0], /No POST body received/)
})

test('doPost rejects malformed JSON', () => {
  const { post } = run()
  const result = post('{not json')
  assert.equal(result.ok, false)
  assert.match(result.errors[0], /not valid JSON/)
})

test('doPost enforces the shared secret from the query string or the body', () => {
  const { post } = run({ properties: { SPREADSHEET_ID, WEBHOOK_SECRET: 'hunter2' } })
  const rejected = post(payload)
  assert.equal(rejected.ok, false)
  assert.match(rejected.errors[0], /Invalid or missing secret/)

  const wrong = post({ ...payload, secret: 'nope' })
  assert.equal(wrong.ok, false)

  const fromBody = post({ ...payload, secret: 'hunter2' })
  assert.equal(fromBody.ok, true)

  const fromQuery = post(payload, { parameter: { secret: 'hunter2' } })
  assert.equal(fromQuery.ok, true)
})

test('a sheet that cannot be written is reported without losing the other sheets', () => {
  const { sheet, post } = run({ failWrites: ['Spawners'] })
  const result = post(payload)
  assert.equal(result.ok, false)
  assert.equal(result.written.Spawners, 0)
  assert.match(result.errors.join(' '), /Spawners: cannot write to Spawners/)
  assert.equal(sheet('Bots').rows.length, 3, 'Bots is still written')
})

test('testWrite runs an in-editor smoke test through the real write path', () => {
  const { sandbox, logged, sheet } = run()
  const written = JSON.parse(sandbox.testWrite())
  assert.equal(written.ok, true)
  assert.equal(written.written.Bots, 1)
  assert.equal(written.written.Spawners, 1)
  assert.equal(logged.length, 1)
  assert.equal(sheet('Spawners').rows[1][0], 'TestBot')
})

test('setWebhookSecret and setHistorySheet store their script properties', () => {
  const { sandbox, properties, post, sheet } = run()
  sandbox.setWebhookSecret('shared-value')
  sandbox.setHistorySheet('SpawnerHistory')
  assert.equal(properties.WEBHOOK_SECRET, 'shared-value')
  assert.equal(properties.HISTORY_SHEET, 'SpawnerHistory')
  // With a secret configured, a payload carrying it is accepted and the history
  // tab is appended to instead of replaced.
  post({ ...payload, secret: 'shared-value' })
  post({ ...payload, secret: 'shared-value' })
  assert.equal(sheet('SpawnerHistory').rows.length, 3, 'header + one row per run')
  assert.equal(sheet('SpawnerHistory').rows[0][0], 'appendedAt')
  assert.equal(sheet('Spawners').rows.length, 2, 'the current snapshot is still replaced, not appended')
})
