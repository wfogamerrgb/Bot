'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('../timeseries')

const HOUR = 3600000
const T0 = 1700000000000

function store () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeseries-'))
  return { dir, store: ts.createTimeseriesStore({ file: path.join(dir, 'timeseries.jsonl') }) }
}

test('a sample keeps the fields it has and drops the ones it does not', () => {
  const sample = ts.botSample({ bot: 'BotA', shards: 10, coins: null, balance: 5.5, rank: 'Regent', banned: false, source: 'data' }, T0)
  assert.deepEqual(sample, { t: T0, kind: 'bot', bot: 'BotA', shards: 10, coins: null, balance: 5.5, rank: 'Regent', banned: false, source: 'data' })
  const partial = ts.botSample({ bot: 'BotA', shards: 3 }, T0)
  assert.deepEqual(Object.keys(partial).sort(), ['bot', 'kind', 'shards', 't'])
})

test('a fleet sample totals what it can and counts the rest', () => {
  const fleet = ts.fleetSample([
    { bot: 'A', shards: 10, coins: 2, balance: 100.5, rank: 'Regent', banned: false },
    { bot: 'B', shards: 5, coins: 3, balance: 200.25, rank: 'Member', banned: true },
    { bot: 'C', shards: null, coins: 1, balance: null, rank: 'N/A', banned: false }
  ], T0)
  assert.equal(fleet.kind, 'fleet')
  assert.equal(fleet.bots, 3)
  assert.equal(fleet.shards, 15)
  assert.equal(fleet.coins, 6)
  assert.equal(fleet.balance, 300.75)
  assert.equal(fleet.regents, 1)
  assert.equal(fleet.banned, 1)
})

test('samples survive a round trip through the file and a corrupt line is skipped', () => {
  const { dir, store: s } = store()
  s.append(ts.botSample({ bot: 'BotA', shards: 1 }, T0))
  fs.appendFileSync(s.file, 'not json\n')
  s.append(ts.botSample({ bot: 'BotA', shards: 2 }, T0 + HOUR))

  const reloaded = ts.createTimeseriesStore({ file: s.file })
  assert.equal(reloaded.all().length, 2)
  assert.equal(reloaded.since(T0 + 1).length, 1)
  assert.equal(reloaded.since(T0, { bot: 'BotB' }).length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('buckets group by window and keep the last reading, plus the spike', () => {
  const { dir, store: s } = store()
  s.append({ t: T0, kind: 'fleet', shards: 10 })
  s.append({ t: T0 + 1000, kind: 'fleet', shards: 25 })
  s.append({ t: T0 + 2000, kind: 'fleet', shards: 12 })
  s.append({ t: T0 + HOUR, kind: 'fleet', shards: 40 })

  const buckets = s.bucket('shards', { bucketMs: HOUR, kind: 'fleet' })
  assert.equal(buckets.length, 2)
  assert.equal(buckets[0].last, 12, 'the bucket reports where the hour ended up')
  assert.equal(buckets[0].max, 25, 'and the spike inside it is not smoothed away')
  assert.equal(buckets[0].count, 3)
  assert.equal(buckets[1].last, 40)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('buckets can be scoped to one bot, which is what the per-bot chart needs', () => {
  const { dir, store: s } = store()
  s.append(ts.botSample({ bot: 'BotA', shards: 1 }, T0))
  s.append(ts.botSample({ bot: 'BotB', shards: 99 }, T0))
  const onlyA = s.bucket('shards', { bucketMs: HOUR, kind: 'bot', bot: 'BotA' })
  assert.equal(onlyA.length, 1)
  assert.equal(onlyA[0].last, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a summary reports first, last, delta and the hourly rate', () => {
  const { dir, store: s } = store()
  s.append({ t: T0, kind: 'fleet', shards: 100 })
  s.append({ t: T0 + 2 * HOUR, kind: 'fleet', shards: 400 })
  const summary = s.summarize('shards')
  assert.equal(summary.first, 100)
  assert.equal(summary.last, 400)
  assert.equal(summary.delta, 300)
  assert.equal(summary.perHour, 150)
  assert.equal(summary.min, 100)
  assert.equal(summary.max, 400)
  assert.equal(s.summarize('coins'), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('ban and rank changes are derived from the samples rather than a second log', () => {
  const { dir, store: s } = store()
  s.append(ts.botSample({ bot: 'BotA', banned: false, rank: 'Member' }, T0))
  s.append(ts.botSample({ bot: 'BotA', banned: true, rank: 'Member' }, T0 + HOUR))
  s.append(ts.botSample({ bot: 'BotA', banned: true, rank: 'Regent' }, T0 + 2 * HOUR))
  s.append(ts.botSample({ bot: 'BotA', banned: false, rank: 'Regent' }, T0 + 3 * HOUR))

  const events = s.events()
  assert.equal(events.bans.length, 2)
  assert.equal(events.bans[0].banned, true)
  assert.equal(events.bans[1].banned, false)
  assert.equal(events.ranks.length, 1)
  assert.deepEqual(events.ranks[0], { bot: 'BotA', t: T0 + 2 * HOUR, rank: 'Regent', previous: 'Member' })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the snapshot carries the series, the latest value per bot and the events', () => {
  const { dir, store: s } = store()
  s.append(ts.botSample({ bot: 'BotA', shards: 5, balance: 10, rank: 'Regent' }, T0))
  s.append(ts.botSample({ bot: 'BotA', shards: 7, balance: 20, rank: 'Regent' }, T0 + HOUR))
  s.append(ts.fleetSample([{ shards: 7, coins: 1, balance: 20, rank: 'Regent' }], T0 + HOUR))
  const snap = s.snapshot({ bucketMs: HOUR, since: T0 - 1 })
  assert.deepEqual(snap.bots, ['BotA'])
  assert.equal(snap.latest.BotA.shards, 7)
  assert.equal(snap.totalSamples, 3)
  assert.equal(snap.series.shards.length, 1)
  assert.equal(snap.summary.shards.last, 7)
  assert.equal(snap.summary.shards.delta, 0, 'one fleet sample cannot infer a change from a bot sample')
  const scoped = s.snapshot({ bucketMs: HOUR, since: T0 - 1, bot: 'BotA' })
  assert.equal(scoped.summary.shards.delta, 2)
  assert.equal(snap.series.regents.length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('charts skip the warm-up ramp after each run start', () => {
  const { dir, store: s } = store()
  // The first sample of a series starts a run; the ramp after it is warm-up.
  s.append(ts.botSample({ bot: 'BotA', shards: 1, source: 'test' }, T0))
  s.append(ts.botSample({ bot: 'BotA', shards: 2, source: 'test' }, T0 + 20 * 60000))
  s.append(ts.botSample({ bot: 'BotA', shards: 9, source: 'test' }, T0 + 51 * 60000))
  // A 'startup' sample is the bot script booting again: new run, new ramp.
  s.append(ts.botSample({ bot: 'BotA', shards: 5, source: 'startup' }, T0 + 2 * HOUR))
  s.append(ts.botSample({ bot: 'BotA', shards: 6, source: 'test' }, T0 + 2 * HOUR + 10 * 60000))

  const warm = s.summarize('shards', { warmupMs: 50 * 60000 })
  assert.deepEqual(warm.points.map(p => p.value), [9], 'only the sample past the ramp counts')
  const raw = s.summarize('shards')
  assert.equal(raw.points.length, 5, 'warm-up off keeps everything')
  const buckets = s.bucket('shards', { bucketMs: 24 * HOUR, warmupMs: 50 * 60000 })
  assert.equal(buckets.reduce((n, b) => n + b.count, 0), 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a long silence counts as a restart even without a startup sample', () => {
  const { dir, store: s } = store()
  s.append(ts.botSample({ bot: 'BotA', shards: 1, source: 'test' }, T0))
  s.append(ts.botSample({ bot: 'BotA', shards: 2, source: 'test' }, T0 + 2 * HOUR))
  // Four hours of silence: sampling resumed as if the script had just started,
  // so this sample opens a new run and its ramp is skipped too.
  s.append(ts.botSample({ bot: 'BotA', shards: 3, source: 'test' }, T0 + 6 * HOUR))
  s.append(ts.botSample({ bot: 'BotA', shards: 4, source: 'test' }, T0 + 6 * HOUR + 61 * 60000))
  const warm = s.summarize('shards', { warmupMs: 50 * 60000 })
  assert.deepEqual(warm.points.map(p => p.value), [2, 4])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('fleet buckets carry the bot count and a per-bot line that survives a restart', () => {
  const { dir, store: s } = store()
  s.append(ts.fleetSample([{ bot: 'A', shards: 100 }, { bot: 'B', shards: 100 }], T0))
  // After a restart only one bot is back yet: the total falls, the per-bot
  // average does not — which is the line the charts plot.
  s.append(ts.fleetSample([{ bot: 'A', shards: 105 }], T0 + HOUR))

  const buckets = s.bucket('shards', { bucketMs: HOUR, kind: 'fleet' })
  assert.equal(buckets[0].last, 200)
  assert.equal(buckets[0].bots, 2)
  assert.equal(buckets[0].perLast, 100)
  assert.equal(buckets[0].perMean, 100)
  assert.equal(buckets[1].last, 105, 'the raw total drops when a bot is offline')
  assert.equal(buckets[1].bots, 1)
  assert.equal(buckets[1].perLast, 105, 'the per-bot line does not')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a per-bot average divides by the bots that reported, not the roster', () => {
  const { dir, store: s } = store()
  const fleet = ts.fleetSample([
    { bot: 'A', shards: 10 },
    { bot: 'B', shards: 20 },
    { bot: 'C', shards: null, coins: 1 }
  ], T0)
  assert.equal(fleet.bots, 3)
  assert.equal(fleet.shards, 30)
  assert.equal(fleet.contrib.shards, 2, 'only two bots produced the shard sum')
  assert.equal(fleet.contrib.coins, 1)
  s.append(fleet)
  const buckets = s.bucket('shards', { bucketMs: HOUR, kind: 'fleet' })
  assert.equal(buckets[0].perLast, 15, '30 over the 2 bots that reported')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the snapshot reports what the warm-up skip left out', () => {
  const { dir, store: s } = store()
  s.append(ts.fleetSample([{ bot: 'A', shards: 10 }], T0))
  s.append(ts.fleetSample([{ bot: 'A', shards: 20 }], T0 + 30 * 60000))
  s.append(ts.fleetSample([{ bot: 'A', shards: 30 }], T0 + 2 * HOUR))

  const snap = s.snapshot({ bucketMs: HOUR, since: T0 - 1, warmupMs: 50 * 60000 })
  assert.equal(snap.warmupMs, 50 * 60000)
  assert.equal(snap.warmupSkipped, 2)
  assert.equal(snap.summary.shards.last, 30)
  assert.equal(snap.series.shards.length, 1)
  assert.ok(snap.series.bots.length >= 1, 'the snapshot charts how many bots the fleet had')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('explicit process starts and query cutoffs do not create false warm-up windows', () => {
  const { dir, store: s } = store()
  try {
    s.append({ t: T0 + HOUR, kind: 'fleet', shards: 200, bots: 2, runStartedAt: T0 })
    s.append({ t: T0 + 2 * HOUR, kind: 'fleet', shards: 105, bots: 1, runStartedAt: T0 })
    s.append({ t: T0 + 3 * HOUR, kind: 'bot', bot: 'A', shards: 9999, runStartedAt: T0 })
    const snap = s.snapshot({ since: T0 + 2 * HOUR, warmupMs: 3000000 })
    assert.equal(snap.series.shards.length, 1, 'cutoff is not a restart')
    assert.equal(snap.summary.shards.last, 105, 'no mixing individual bot and fleet points')
    assert.equal(s.snapshot({ since: T0, warmupMs: 3000000 }).summary.shardsPerBot.delta, 5)
    s.append({ t: T0 + 4 * HOUR, kind: 'fleet', shards: 1, bots: 1, runStartedAt: T0 + 4 * HOUR })
    assert.equal(s.snapshot({ since: T0, warmupMs: 3000000 }).warmupSkipped, 1)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('fleet ban buckets preserve the full count and zero contributor count is not a denominator fallback', () => {
  const { dir, store: s } = store()
  try {
    s.append({ t: T0, kind: 'fleet', banned: 7, shards: 10, bots: 20, contrib: { shards: 0 } })
    assert.equal(s.bucket('banned')[0].last, 7)
    assert.equal(s.bucket('shards')[0].perLast, undefined)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a missing data file is an empty history, not a crash', () => {
  const s = ts.createTimeseriesStore({ file: path.join(os.tmpdir(), 'nope-timeseries', 'x.jsonl') })
  assert.deepEqual(s.all(), [])
  assert.equal(s.summarize('shards'), null)
  assert.deepEqual(s.bucket('shards'), [])
  assert.deepEqual(s.events(), { bans: [], ranks: [] })
})
