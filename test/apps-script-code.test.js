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

const isEmptyCell = value => value === '' || value === null || value === undefined

// Writes a user-owned column as if the person had typed it in themselves:
// a header, a value, and a formula that must survive every subsequent push.
function seedUserColumn (sheet, col, header, value, formula) {
  const range = sheet.getRange(1, col, 2, 1)
  range.setValues([[header], [value]])
  if (formula) sheet.getRange(2, col).setFormula(formula)
}

// A push that owns only `bot`, leaving column 2 as the user's own.
const botsOnly = name => ({
  bots: [{ bot: name }],
  spawners: [],
  lifetime: { totalEarned: 0, samples: 0 }
})

// A sheet mock with the fidelity the write path needs: cells can be empty,
// number formats / bold / formulas are recorded per cell, and getLastRow()
// behaves like Sheets (the last row holding anything) rather than rows.length.
function makeSheet (name, { failWrites = false } = {}) {
  const rows = []
  const formats = []
  const formulas = []
  const bold = []
  const cellValue = (row, col) => {
    const line = rows[row - 1]
    return line && line[col - 1] !== undefined ? line[col - 1] : ''
  }
  return {
    name,
    rows,
    getName: () => name,
    clearContents: () => { rows.length = 0 },
    setFrozenRows: () => {},
    getMaxRows: () => Math.max(rows.length, 1),
    insertRowsAfter: () => {},
    getLastRow: () => {
      for (let i = rows.length; i > 0; i--) {
        if ((rows[i - 1] || []).some(value => !isEmptyCell(value))) return i
      }
      return 0
    },
    getLastColumn: () => rows.reduce((max, line) => {
      let last = 0
      ;(line || []).forEach((value, index) => { if (!isEmptyCell(value)) last = index + 1 })
      return Math.max(max, last)
    }, 0),
    formatAt: (row, col) => (formats[row] && formats[row][col]) || '',
    formulaAt: (row, col) => (formulas[row] && formulas[row][col]) || '',
    isBold: (row, col) => Boolean(bold[row] && bold[row][col]),
    getRange (row, col, numRows = 1, numCols = 1) {
      const range = {
        setValues (values) {
          if (failWrites) throw new Error('cannot write to ' + name)
          values.forEach((line, i) => {
            const at = row - 1 + i
            rows[at] = rows[at] || []
            line.forEach((value, j) => { rows[at][col - 1 + j] = value })
          })
          return range
        },
        getValues () {
          const out = []
          for (let i = 0; i < numRows; i++) {
            out.push(Array.from({ length: numCols }, (_, j) => cellValue(row + i, col + j)))
          }
          return out
        },
        setNumberFormat (format) {
          for (let i = 0; i < numRows; i++) {
            for (let j = 0; j < numCols; j++) {
              formats[row + i] = formats[row + i] || {}
              formats[row + i][col + j] = format
            }
          }
          return range
        },
        setFontWeight (weight) {
          for (let i = 0; i < numRows; i++) {
            for (let j = 0; j < numCols; j++) {
              bold[row + i] = bold[row + i] || {}
              bold[row + i][col + j] = weight === 'bold'
            }
          }
          return range
        },
        setFormula (formula) {
          if (failWrites) throw new Error('cannot write to ' + name)
          formulas[row] = formulas[row] || {}
          formulas[row][col] = formula
          return range
        },
        setValue (value) {
          if (failWrites) throw new Error('cannot write to ' + name)
          rows[row - 1] = rows[row - 1] || []
          rows[row - 1][col - 1] = value
          return range
        }
      }
      return range
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
        setProperty: (key, value) => { properties[key] = value },
        deleteProperty: (key) => { delete properties[key] }
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
  assert.deepEqual(result.written, { Bots: 2, Spawners: 1, Lifetime: 1, Bans: 0 })
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
  assert.deepEqual(result.written, { Bots: 1, Spawners: 0, Lifetime: 0, Bans: 0 })
  assert.deepEqual(sheet('Bots').rows[1], ['BotA'])
  assert.deepEqual(sheet('Lifetime').rows, [], 'an empty lifetime clears the tab instead of failing')
})

test('doPost clears stale rows instead of appending forever', () => {
  const { sheet, post } = run()
  post({ bots: [{ bot: 'BotA' }, { bot: 'BotB' }], spawners: [], lifetime: { totalEarned: 0, samples: 0 } })
  post({ bots: [{ bot: 'BotA' }], spawners: [], lifetime: { totalEarned: 0, samples: 0 } })
  const bots = sheet('Bots')
  assert.equal(bots.getLastRow(), 2, 'header + one data row — the departed bot is gone')
  assert.equal(bots.rows[1][0], 'BotA')
  assert.equal(bots.rows[2][0], '', 'the row the other bot used is emptied, not left stale')
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
  assert.equal(sheet('Bots').getLastRow(), 4, 'Bots is still written: 2 data rows + the TOTAL row')
})

test('testWrite runs an in-editor smoke test through the real write path', () => {
  const { sandbox, logged, sheet } = run()
  const written = JSON.parse(sandbox.testWrite())
  assert.equal(written.ok, true)
  assert.equal(written.written.Bots, 2)
  assert.equal(written.written.Spawners, 1)
  assert.equal(logged.length, 1)
  assert.equal(sheet('Spawners').rows[1][0], 'TestBotA')
  assert.ok(written.layout.Bots.balance, 'the response reports which column each owned header landed in')
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

// ── Your own columns, tabs, and formatting ──────────────────────────────────

// The contract that matters most when the sheet is shared with hand-made
// content: a push writes its own columns and nothing else.
test('a push never touches columns the script does not own', () => {
  const { sheet, post } = run()
  post(botsOnly('BotA'))
  const bots = sheet('Bots')
  seedUserColumn(bots, 2, 'My Notes', 'keep me', '=COUNTA(A2:A)')
  post(botsOnly('BotA'))

  assert.equal(bots.rows[0][1], 'My Notes', 'your header survives')
  assert.equal(bots.rows[1][1], 'keep me', 'your value survives')
  assert.equal(bots.formulaAt(2, 2), '=COUNTA(A2:A)', 'your formula survives')
  assert.equal(bots.rows[0][0], 'bot', 'the owned column is still maintained')
  assert.equal(bots.rows[1][0], 'BotA')
})

test('a new payload column is appended after your columns, never over them', () => {
  const { sheet, post } = run()
  post(botsOnly('BotA'))
  const bots = sheet('Bots')
  seedUserColumn(bots, 2, 'My Notes', 'mine')
  post({ bots: [{ bot: 'BotA', balance: 5 }], spawners: [], lifetime: {} })

  assert.equal(bots.rows[0][1], 'My Notes', 'your column keeps its place')
  assert.equal(bots.rows[1][1], 'mine')
  assert.equal(bots.rows[0][2], 'balance', 'the new owned column goes to the right of yours')
  assert.equal(bots.rows[1][2], 5)
})

// An empty payload used to call clearContents() on the whole tab, which wiped a
// hand-made summary on a tab the script had never written to.
test('an empty payload never clears a tab the script does not own', () => {
  const { sandbox, post } = run()
  const lifetime = sandbox.SpreadsheetApp.openById(SPREADSHEET_ID).insertSheet('Lifetime')
  lifetime.getRange(1, 1, 2, 1).setValues([['My own summary'], ['do not clear me']])
  const result = post({ bots: [{ bot: 'BotA' }], spawners: [], lifetime: {} })
  assert.equal(result.ok, true)
  assert.equal(result.written.Lifetime, 0)
  assert.deepEqual(lifetime.rows[0], ['My own summary'])
  assert.deepEqual(lifetime.rows[1], ['do not clear me'])
})

test('only the managed tabs are ever created', () => {
  const { sandbox, post } = run()
  post(payload)
  const names = sandbox.SpreadsheetApp.openById(SPREADSHEET_ID).getSheets().map(sheet => sheet.getName())
  assert.deepEqual(names, ['Bots', 'Spawners', 'Lifetime', 'Bans'])
})

// ── Bans tab ────────────────────────────────────────────────────────────────

test('ban records are published to a Bans tab', () => {
  const { sheet, post } = run()
  const expiresAt = Date.UTC(2026, 9, 16, 12, 41, 25)
  const result = post({
    bots: [],
    spawners: [],
    lifetime: { totalEarned: 0, samples: 0 },
    bans: [
      { bot: 'Hypr_7_alt', kind: 'temporary', reason: 'Alt Farming (3rd)', caseId: '1129', duration: '29 days, 11 hours, 17 minutes', expiresAt: new Date(expiresAt).toISOString(), permanent: false, firstBannedAt: new Date(expiresAt).toISOString(), lastBannedAt: new Date(expiresAt).toISOString(), count: 2 },
      { bot: 'Hypr_7_core', kind: 'permanent', reason: 'cheating', caseId: '', duration: '', expiresAt: '', permanent: true, firstBannedAt: '', lastBannedAt: '', count: 1 }
    ]
  })
  assert.equal(result.ok, true)
  assert.equal(result.written.Bans, 2, 'the Bans tab is written like the other managed tabs')

  const bans = sheet('Bans')
  const headers = bans.rows[0]
  // Columns: bot, kind, reason, caseId, duration, expiresAt, permanent, firstBannedAt, lastBannedAt, count
  assert.equal(headers[0], 'bot')
  assert.equal(headers[6], 'permanent')
  const value = (row, header) => bans.rows[row][headers.indexOf(header)]
  assert.equal(value(1, 'bot'), 'Hypr_7_alt')
  assert.equal(value(1, 'kind'), 'temporary')
  assert.equal(value(1, 'reason'), 'Alt Farming (3rd)')
  assert.equal(value(1, 'caseId'), '1129')
  assert.equal(value(1, 'count'), 2)
  assert.equal(bans.formulaAt(4, 1), '', 'no TOTAL row on a one-row-per-bot roster')
  // Code.gs runs in its own VM realm, so its Date constructor differs from ours.
  const isDate = cell => Object.prototype.toString.call(cell) === '[object Date]'
  assert.ok(isDate(value(1, 'expiresAt')), 'an expiry is a real date, so a formula can compare it')
  assert.equal(value(1, 'expiresAt').toISOString(), '2026-10-16T12:41:25.000Z')
  assert.equal(value(2, 'permanent'), true)
  assert.equal(value(2, 'expiresAt'), '', 'a permanent ban has no expiry, not 1970-01-01')
})

test('an empty bans list leaves the Bans tab alone', () => {
  const { sheet, post } = run()
  post({ bots: [{ bot: 'BotA' }], spawners: [], lifetime: {}, bans: [] })
  assert.equal(sheet('Bans').getLastRow(), 0)
})

// ── Totals ──────────────────────────────────────────────────────────────────

test('appends a TOTAL row summing balance, coins, and shards on Bots', () => {
  const { sheet, post } = run()
  const result = post({
    bots: [
      { bot: 'BotA', shards: 1200, coins: 900, balance: 1234.5 },
      { bot: 'BotB', shards: 800, coins: 150, balance: 765.25 }
    ],
    spawners: [],
    lifetime: { totalEarned: 0, samples: 0 }
  })
  const bots = sheet('Bots')
  // columns: bot(A), shards(B), coins(C), balance(D)
  assert.equal(result.written.Bots, 2, 'the TOTAL row is not counted as a data row')
  assert.equal(bots.rows[3][0], 'TOTAL')
  assert.equal(bots.formulaAt(4, 2), '=SUM(B2:B3)')
  assert.equal(bots.formulaAt(4, 3), '=SUM(C2:C3)')
  assert.equal(bots.formulaAt(4, 4), '=SUM(D2:D3)')
  assert.equal(bots.formatAt(4, 4), '#,##0.00')
  assert.ok(bots.isBold(4, 4), 'the TOTAL row is bolded')
})

test('Spawners totals cover earned and lifetimeEarned but not the spawner number', () => {
  const { sheet, post } = run()
  post({
    bots: [],
    spawners: [
      { bot: 'BotA', spawnerNumber: 1, earned: 10, lifetimeEarned: 100 },
      { bot: 'BotA', spawnerNumber: 2, earned: 5, lifetimeEarned: 50 }
    ],
    lifetime: { totalEarned: 150, samples: 2 }
  })
  const spawners = sheet('Spawners')
  // columns: bot(A), spawnerNumber(B), earned(C), lifetimeEarned(D)
  assert.equal(spawners.rows[3][0], 'TOTAL')
  assert.equal(spawners.formulaAt(4, 3), '=SUM(C2:C3)')
  assert.equal(spawners.formulaAt(4, 4), '=SUM(D2:D3)')
  assert.equal(spawners.formulaAt(4, 2), '', 'spawnerNumber is not summed')
})

test('a single data row gets no TOTAL row (Lifetime stays a one-row summary)', () => {
  const { sheet, post } = run()
  post(payload)
  assert.equal(sheet('Lifetime').getLastRow(), 2, 'header + the single summary row')
  assert.equal(sheet('Lifetime').rows[1][0], 100)
})

test('TOTALS_ROW moves the totals to the top or switches them off', () => {
  const top = run()
  top.sandbox.setTotalsRow('top')
  const topResult = top.post({ bots: [{ bot: 'BotA' }, { bot: 'BotB' }], spawners: [], lifetime: {} })
  assert.equal(top.sheet('Bots').rows[1][0], 'TOTAL', 'row 2 is the totals row')
  assert.equal(top.sheet('Bots').rows[2][0], 'BotA', 'data starts at row 3')
  assert.equal(top.sheet('Bots').formulaAt(2, 1), '', 'the label column shows the label, not a sum')
  assert.equal(topResult.written.Bots, 2)

  const off = run()
  off.sandbox.setTotalsRow('off')
  off.post({ bots: [{ bot: 'BotA' }, { bot: 'BotB' }], spawners: [], lifetime: {} })
  assert.equal(off.sheet('Bots').getLastRow(), 3, 'header + two data rows, no TOTAL row')
})

test('TOTALS_COLUMNS narrows which columns are summed', () => {
  const { sandbox, sheet, post } = run()
  sandbox.setTotalsColumns(['balance'])
  post({ bots: [{ bot: 'BotA', coins: 1, balance: 2 }, { bot: 'BotB', coins: 3, balance: 4 }], spawners: [], lifetime: {} })
  const bots = sheet('Bots')
  // columns: bot(A), coins(B), balance(C)
  assert.equal(bots.formulaAt(4, 3), '=SUM(C2:C3)')
  assert.equal(bots.formulaAt(4, 2), '', 'coins is no longer summed')
})

// ── Readable times and number formats ──────────────────────────────────────

test('epoch timestamps become real dates instead of 1758067200000', () => {
  const { sheet, post } = run()
  const when = Date.UTC(2026, 8, 17, 0, 45, 43)
  post({
    bots: [
      { bot: 'BotA', recordedAt: when },
      { bot: 'BotB', recordedAt: when, lastRunAt: '2026-09-17T00:45:43.000Z' }
    ],
    spawners: [],
    lifetime: { totalEarned: 0, samples: 0 }
  })
  const bots = sheet('Bots')
  // columns: bot(A), recordedAt(B), lastRunAt(C)
  // Code.gs runs in its own VM realm, so its Date constructor differs from ours.
  const isDate = value => Object.prototype.toString.call(value) === '[object Date]'
  assert.ok(isDate(bots.rows[1][1]), 'an epoch value becomes a date cell')
  assert.equal(bots.rows[1][1].toISOString(), '2026-09-17T00:45:43.000Z')
  assert.ok(isDate(bots.rows[2][2]), 'an ISO string becomes a date cell too')
})

test('an unparseable timestamp falls back to plain text', () => {
  const { sheet, post } = run()
  post({ bots: [{ bot: 'BotA', recordedAt: 'sometime' }, { bot: 'BotB', recordedAt: null }], spawners: [], lifetime: {} })
  assert.equal(sheet('Bots').rows[1][1], 'sometime')
  assert.equal(sheet('Bots').rows[2][1], '')
})

test('owned columns get number formats; text columns get none', () => {
  const { sheet, post } = run()
  post({ bots: [{ bot: 'BotA', balance: 1234.5, coins: 900, rank: 'Member' }, { bot: 'BotB', balance: 1, coins: 2, rank: 'Regent' }], spawners: [], lifetime: {} })
  const bots = sheet('Bots')
  // columns: bot(A), balance(B), coins(C), rank(D)
  assert.equal(bots.formatAt(2, 2), '#,##0.00')
  assert.equal(bots.formatAt(2, 3), '#,##0')
  assert.equal(bots.formatAt(2, 4), '', 'rank is text')
  assert.equal(bots.formatAt(2, 1), '', 'bot is text')
})

test('NUMBER_FORMATS=off leaves your own number formatting alone', () => {
  const { sandbox, sheet, post } = run()
  sandbox.setNumberFormats('off')
  post({ bots: [{ bot: 'BotA', balance: 1 }, { bot: 'BotB', balance: 2 }], spawners: [], lifetime: {} })
  assert.equal(sheet('Bots').formatAt(2, 2), '')
})

test('TIMESTAMP_FORMAT is applied only when you set it', () => {
  const plain = run()
  plain.post({ bots: [{ bot: 'BotA', recordedAt: 1000 }, { bot: 'BotB', recordedAt: 2000 }], spawners: [], lifetime: {} })
  assert.equal(plain.sheet('Bots').formatAt(2, 2), '', 'the spreadsheet locale format is used by default')

  const forced = run()
  forced.sandbox.setTimestampFormat('yyyy-mm-dd hh:mm')
  forced.post({ bots: [{ bot: 'BotA', recordedAt: 1000 }, { bot: 'BotB', recordedAt: 2000 }], spawners: [], lifetime: {} })
  assert.equal(forced.sheet('Bots').formatAt(2, 2), 'yyyy-mm-dd hh:mm')
  assert.equal(forced.sandbox.clearTimestampFormat(), 'TIMESTAMP_FORMAT cleared — dates use the spreadsheet locale format')
})

// ── Layout memory ──────────────────────────────────────────────────────────

test('doGet and the POST response report the owned layout', () => {
  const { sandbox, post } = run()
  const result = post(botsOnly('BotA'))
  assert.deepEqual(result.layout.Bots, { bot: 'A' })
  const health = JSON.parse(sandbox.doGet().getContent())
  assert.equal(health.version, 3)
  assert.deepEqual(health.layout.Bots, ['bot'])
  assert.equal(health.totalsRow, 'bottom')
  assert.equal(health.numberFormats, 'custom')
})

test('renaming an owned header makes the script append a fresh column', () => {
  const { sheet, post } = run()
  post(botsOnly('BotA'))
  const bots = sheet('Bots')
  bots.getRange(1, 1).setValues([['Account']])
  post(botsOnly('BotA'))
  assert.deepEqual([bots.rows[0][0], bots.rows[0][1]], ['Account', 'bot'], 'the renamed column is left to you')
})

test('resetLayout hands the owned columns back to you', () => {
  const { sandbox, properties, post } = run()
  post(botsOnly('BotA'))
  assert.ok(properties.OWNED_COLUMNS_Bots, 'ownership is remembered between pushes')
  const report = sandbox.resetLayout()
  assert.match(report, /Bots/)
  assert.equal(properties.OWNED_COLUMNS_Bots, undefined)
  assert.equal(properties.OWNED_ROWS_Bots, undefined)
})

test('listSettings prints the active layout so it can be checked without a push', () => {
  const { sandbox, post } = run()
  post(botsOnly('BotA'))
  const text = sandbox.listSettings()
  assert.match(text, /TOTALS_ROW: bottom/)
  assert.match(text, /TOTALS_COLUMNS: balance, coins, shards/)
  assert.match(text, /Bots: bot/)
  assert.match(text, /NUMBER_FORMATS: \{/)
  assert.match(text, /TIMESTAMP_FORMAT: \(spreadsheet locale default\)/)
})
