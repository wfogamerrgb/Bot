'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  createSpawnerDataStore,
  buildSpawnerSnapshot,
  pushSpawnerSnapshot,
  computeEarnedPerHour,
  formatMoney,
  formatInterval
} = require('../spawner-data')

// A throwaway store directory per test — never touches the repo's ./data.
function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spawner-data-'))
}

function sampleRun (overrides = {}) {
  return {
    bot: 'A',
    startedAt: 1_000_000,
    finishedAt: 1_060_000,
    intervalMs: 3_600_000, // one hour since the previous run
    balanceStart: 100,
    balanceEnd: 112.5,
    botPosition: { x: 10.5, y: 64, z: -3.25, dimension: 'overworld' },
    spawners: [
      { index: 1, label: 'Spawner 1', x: 11, y: 64, z: -3, balanceBefore: 100, balanceAfter: 104, earned: 4 },
      { index: 2, label: 'Spawner 2', x: 15, y: 63, z: -9, balanceBefore: 104, balanceAfter: 108.5, earned: 4.5 },
      { index: 3, label: 'Spawner 3', x: 19, y: 62, z: -12, balanceBefore: 108.5, balanceAfter: null, earned: null, status: 'balance N/A' }
    ],
    ...overrides
  }
}

test('computeEarnedPerHour derives $/hour and returns null without a baseline', () => {
  assert.equal(computeEarnedPerHour(12.5, 3_600_000), 12.5)
  assert.equal(computeEarnedPerHour(6, 1_800_000), 12)
  assert.equal(computeEarnedPerHour(1, 60_000), 60)
  // First run / unknown interval → N/A rather than a wrong number.
  assert.equal(computeEarnedPerHour(12, null), null)
  assert.equal(computeEarnedPerHour(12, 0), null)
  assert.equal(computeEarnedPerHour(null, 3_600_000), null)
  assert.equal(computeEarnedPerHour(undefined, undefined), null)
})

test('formatMoney/formatInterval render N/A instead of NaN', () => {
  assert.equal(formatMoney(null), 'N/A')
  assert.equal(formatMoney(1.5), '$1.50')
  assert.equal(formatInterval(null), 'N/A')
  assert.equal(formatInterval(3_600_000), '1h')
  assert.equal(formatInterval(5_400_000), '1h 30m')
})

test('JSON store records runs, per-spawner rows, latest-per-bot and lifetime totals', () => {
  const dir = tempDir()
  const store = createSpawnerDataStore({ dir, kind: 'json', log: () => {} })

  assert.equal(store.backendKind(), 'json')
  assert.equal(store.finishedAtFor('A'), null, 'no runs yet → no baseline')

  const first = store.insertRun(sampleRun())
  assert.equal(first.earned, 12.5)
  assert.equal(first.earnedPerHour, 12.5)
  assert.equal(first.spawnerCount, 3)
  assert.equal(first.spawners[0].label, 'Spawner 1')
  assert.equal(first.spawners[2].status, 'balance N/A')
  assert.equal(first.botPosition.dimension, 'overworld')

  // Second run for the same bot + one for another bot.
  store.insertRun(sampleRun({ finishedAt: 4_660_000, balanceStart: 112.5, balanceEnd: 120, earned: 7.5, earnedPerHour: 7.5, spawners: [] }))
  store.insertRun(sampleRun({ bot: 'B', balanceStart: 0, balanceEnd: null, earned: null, spawners: [{ index: 1, label: 'Spawner 1', x: 1, y: 2, z: 3, earned: null }] }))

  assert.equal(store.finishedAtFor('A'), 4_660_000, 'newest run is the baseline for the next one')

  const all = store.listRuns({ limit: 10 })
  assert.equal(all.length, 3)
  assert.equal(all[0].finishedAt, 4_660_000, 'newest first')

  const latest = store.latestRunPerBot()
  assert.deepEqual(latest.map(r => r.bot), ['A', 'B'], 'one current run per bot')
  assert.equal(latest.find(r => r.bot === 'A').finishedAt, 4_660_000)

  const totals = store.totals()
  assert.equal(totals.overall.runs, 3)
  assert.equal(totals.overall.bots, 2)
  assert.equal(totals.overall.earned, 20) // 12.5 + 7.5 (the null-run contributes nothing)
  assert.equal(totals.byBot.A.runs, 2)
  assert.equal(totals.byBot.A.earned, 20)
  assert.equal(totals.byBot.B.earned, 0)
  assert.equal(totals.byBot.A.lastEarned, 7.5)

  // /data's local backup lives next to the store.
  const saved = store.writeSnapshotFile({ hello: 'world' })
  assert.equal(saved.backend, 'json')
  assert.deepEqual(JSON.parse(fs.readFileSync(saved.path, 'utf8')), { hello: 'world' })

  // Re-opening the store reads the JSON file back (persistence, not memory).
  store.close()
  const reopened = createSpawnerDataStore({ dir, kind: 'json', log: () => {} })
  assert.equal(reopened.listRuns({ limit: 10 }).length, 3)
  assert.equal(reopened.finishedAtFor('B'), 1_060_000)
  reopened.close()
})

test('SQLite store matches the JSON store behaviour when node:sqlite is available', (t) => {
  let DatabaseSync
  try { ({ DatabaseSync } = require('node:sqlite')) } catch (_) {}
  if (!DatabaseSync) { t.skip('node:sqlite unavailable on this Node version'); return }

  const dir = tempDir()
  const store = createSpawnerDataStore({ dir, kind: 'sqlite', log: () => {} })
  assert.equal(store.backendKind(), 'sqlite')
  store.insertRun(sampleRun())
  store.insertRun(sampleRun({ finishedAt: 4_660_000, earned: 7.5, earnedPerHour: 7.5, spawners: [] }))

  const latest = store.latestRunPerBot()
  assert.equal(latest.length, 1)
  assert.equal(latest[0].finishedAt, 4_660_000)
  assert.equal(latest[0].earned, 7.5)
  assert.equal(latest[0].intervalMs, 3_600_000)
  assert.equal(store.listRuns({ bot: 'A', limit: 10 }).length, 2)
  assert.equal(store.totals().overall.earned, 20)
  assert.equal(store.finishedAtFor('A'), 4_660_000)
  store.close()
})

test('an unknown store kind falls back to JSON instead of throwing', () => {
  const dir = tempDir()
  const store = createSpawnerDataStore({ dir, kind: 'json', log: () => {} })
  assert.equal(store.backendKind(), 'json')
  store.close()
})

test('buildSpawnerSnapshot emits one current row per bot/spawner plus lifetime totals', () => {
  const runA = {
    bot: 'A',
    finishedAt: 1_060_000,
    intervalMs: 3_600_000,
    balanceStart: 100,
    balanceEnd: 112,
    earned: 12,
    earnedPerHour: 12,
    botPosition: { x: 10, y: 64, z: -3, dimension: 'overworld' },
    spawnerCount: 2,
    spawners: [
      { index: 1, label: 'Spawner 1', x: 11, y: 64, z: -3, earned: 5, balanceBefore: 100, balanceAfter: 105, status: 'ok' },
      { index: 2, label: 'Spawner 2', x: 12, y: 64, z: -4, earned: 7, balanceBefore: 105, balanceAfter: 112, status: 'ok' }
    ]
  }
  const totals = {
    overall: { bots: 1, runs: 3, spawners: 4, earned: 30 },
    byBot: { A: { bot: 'A', runs: 3, spawners: 4, earned: 30, lastEarned: 12, lastEarnedPerHour: 12, firstRunAt: 1_000, lastRunAt: 1_060_000 } }
  }
  const payload = buildSpawnerSnapshot({
    runs: [runA],
    liveStats: [
      { bot: 'A', online: true, rank: 'Regent', coins: 4200, shards: 12, balance: 112, botPosition: { x: 10, y: 64, z: -3, dimension: 'overworld' } },
      { bot: 'Z', online: false, rank: 'N/A', coins: null, shards: null, balance: null, botPosition: null }
    ],
    totals,
    generatedAt: 1_060_000
  })

  assert.equal(payload.mode, 'replace')
  assert.equal(payload.generatedAtIso, new Date(1_060_000).toISOString())
  assert.equal(payload.spawners.length, 2)
  assert.deepEqual(payload.spawners.map(s => s.spawner), ['Spawner 1', 'Spawner 2'])
  assert.equal(payload.spawners[0].earnedPerHour, 5, 'per-spawner rate uses the run interval')
  assert.equal(payload.spawners[0].botX, 10, 'the bot position is recorded alongside the spawner coords')

  const botA = payload.bots.find(b => b.bot === 'A')
  assert.equal(botA.rank, 'Regent')
  assert.equal(botA.coins, 4200)
  assert.equal(botA.lifetimeEarned, 30)
  assert.equal(botA.lastEarnedPerHour, 12)

  // A bot /data has live stats for but that never ran /spawners still gets a row.
  const botZ = payload.bots.find(b => b.bot === 'Z')
  assert.ok(botZ)
  assert.equal(botZ.online, false)
  assert.equal(botZ.lastRunAt, null)

  // Ready-to-write sheet tabs.
  assert.equal(payload.sheetTabs.Bots.header[0], 'Bot')
  assert.equal(payload.sheetTabs.Spawners.rows.length, 2)
  assert.equal(payload.sheetTabs.Spawners.rows[0][0], 'A')
  assert.equal(payload.sheetTabs.Spawners.rows[0][1], 'Spawner 1')
  assert.equal(payload.sheetTabs.Totals.rows[0][3], 30)
  assert.equal(payload.sheetTabs.Totals.summary.earned, 30)
})

test('a first run with no interval reports N/A instead of a fake rate', () => {
  const dir = tempDir()
  const store = createSpawnerDataStore({ dir, kind: 'json', log: () => {} })
  const first = store.insertRun(sampleRun({ intervalMs: null, earnedPerHour: undefined }))
  assert.equal(first.intervalMs, null)
  assert.equal(first.earnedPerHour, null)
  store.close()

  const payload = buildSpawnerSnapshot({ runs: [first], liveStats: [], totals: null })
  assert.equal(payload.bots[0].lastEarnedPerHour, null)
  assert.equal(payload.totals.earned, 0)
})

test('pushSpawnerSnapshot posts the snapshot and reports failures without throwing', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return new Response('{"ok":true}', { status: 200 }) }
  try {
    const res = await pushSpawnerSnapshot('https://example.com/exec', { mode: 'replace' }, { token: 'secret' })
    assert.equal(res.ok, true)
    assert.equal(calls[0].url, 'https://example.com/exec')
    assert.equal(calls[0].opts.method, 'POST')
    assert.equal(calls[0].opts.headers['X-Auth-Token'], 'secret')
    assert.equal(JSON.parse(calls[0].opts.body).token, 'secret')
  } finally {
    globalThis.fetch = original
  }

  globalThis.fetch = async () => { throw new Error('offline') }
  try {
    const res = await pushSpawnerSnapshot('https://example.com/exec', {})
    assert.equal(res.ok, false)
    assert.match(res.error, /offline/)
  } finally {
    globalThis.fetch = original
  }

  assert.equal((await pushSpawnerSnapshot('', {})).ok, false, 'no URL configured → clean failure')
})
