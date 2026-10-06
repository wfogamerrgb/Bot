'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { parseBroadcastTargets } = require('../bot-controls')
const { createEvidenceStore } = require('../evidence')
const createManual = require('../bot-manual')
const { parseOptions, createSpawnerDrop } = require('../spawner-drop')

test('selectors resolve exact names, inclusive displayed numbers, and hyphenated names', () => {
  const roster = ['Alpha-1', 'Beta-2', 'Gamma-3']
  assert.deepEqual(parseBroadcastTargets('1-2 /status', roster).ids, roster.slice(0, 2))
  assert.deepEqual(parseBroadcastTargets('Alpha-1-Gamma-3', roster).ids, roster)
  assert.deepEqual(parseBroadcastTargets('name:Beta-2..Gamma-3 /status', roster).ids, roster.slice(1))
  assert.ok(parseBroadcastTargets('3-1 /status', roster).error)
  assert.equal(parseBroadcastTargets('30 /status', roster).selected, false, 'old bare slow delay is preserved')
})

test('manual direct actions stop automatically, never chat, and relative walk uses current position', async () => {
  const controls = [], goals = [], logs = []
  const bot = {
    entity: { position: new Vec3(10, 64, -20), yaw: 0, pitch: 0 },
    pathfinder: { stop() {}, setGoal(goal) { goals.push(goal) } },
    setControlState(key, value) { controls.push([key, value]) }, clearControlStates() {},
    game: { dimension: 'overworld' }
  }
  const bots = { A: { bot } }
  const manual = createManual({ bots, logFor: (_, text) => logs.push(text), sanitize: String, notifyBotsChanged() {}, SYSTEM_ID: 'system', loadViewerFactory() { throw Error('Must not start viewer') } })
  assert.equal(manual.routeCommand('/manual-interact foward 1ms', 'A'), true)
  assert.deepEqual(controls, [['forward', true]])
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.deepEqual(controls.at(-1), ['forward', false])
  manual.routeCommand('/walk ~2 ~ ~-3 0', 'A')
  assert.equal(goals[0].x, 12)
  assert.equal(goals[0].y, 64)
  assert.equal(goals[0].z, -23)
  manual.routeCommand('/coordinates', 'A')
  assert.match(logs.join('\n'), /X 10.0 Y 64.0 Z -20.0/)
  manual.routeCommand('/manual-interact forward 15s', 'A')
  assert.equal(controls.length, 2, 'invalid duration does not set controls')
  bots.A.connectionState = 'disconnected'
  manual.routeCommand('/manual-interact forward', 'A')
  assert.equal(controls.length, 2)
})

test('evidence persists the last three dumps, death observations and connection reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-evidence-'))
  try {
    const file = path.join(dir, 'evidence.json')
    const store = createEvidenceStore({ file, now: () => 100 })
    for (let n = 0; n < 4; n++) {
      store.startDump('A', { command: '/dump', mode: 'home', n })
      store.captureDumpLine('A', '{green-fg}deposited 2 stacks{/green-fg}')
      store.finishDump('A')
    }
    store.record('A', 'deaths', { source: 'server', reason: 'A was slain by Main' })
    store.record('A', 'connections', { state: 'kicked', reason: 'banned' })
    const audit = createEvidenceStore({ file }).get('A')
    assert.deepEqual(audit.dumps.map(d => d.n), [1, 2, 3])
    assert.equal(audit.dumps[2].messages[0], 'deposited 2 stacks')
    assert.equal(audit.deaths[0].reason, 'A was slain by Main')
    assert.equal(audit.connections[0].state, 'kicked')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

const defaults = { durationMs: 60000, cooldownMs: 10000, mode: 'duration', scope: 'all', terms: ['bones'] }
function dropHarness (ack = true) {
  let time = 0
  const timers = new Map(), calls = [], logs = []
  const target = { position: new Vec3(0, 64, 1) }
  const win = { id: 1, inventoryStart: 2, inventoryEnd: 4, slots: [
    { name: 'bones', type: 1, count: 64 }, { name: 'diamond', type: 2, count: 1 },
    { name: 'bones', type: 1, count: 32 }, null
  ] }
  const bot = new EventEmitter()
  Object.assign(bot, {
    entity: { position: new Vec3(0, 64, 0) }, registry: require('minecraft-data')('1.21.1'), _client: new EventEmitter(),
    findBlocks: () => [target.position], blockAt: () => target, clearControlStates() {},
    async lookAt() {}, async activateBlock() { bot.currentWindow = win; bot.emit('windowOpen', win) },
    async clickWindow(slot, button, mode) {
      calls.push({ t: time, slot, button, mode })
      win.slots[slot] = null // optimistic local mutation is NOT a server acknowledgement
      if (ack) bot._client.emit('set_slot', { windowId: win.id, slot, item: null })
    },
    closeWindow() { bot.currentWindow = null }
  })
  const bots = { A: { bot } }
  const runner = createSpawnerDrop({ bots, log: (_, text) => logs.push(text), online: entry => !!entry.bot.entity, matches: (item, terms) => terms.includes(item.name), defaults: () => defaults, now: () => time,
    setTimer(fn, delay) { const timer = { fn, due: time + delay }; timers.set(timer, timer); return timer }, clearTimer(timer) { timers.delete(timer) } })
  async function flush () { for (let n = 0; n < 20; n++) await Promise.resolve() }
  async function advance (ms) {
    const end = time + ms
    await flush()
    for (let n = 0; n < 10000; n++) {
      const next = [...timers.values()].sort((a, b) => a.due - b.due)[0]
      if (!next || next.due > end) break
      time = next.due; timers.delete(next); next.fn(); await flush()
    }
    time = end; await flush()
  }
  return { runner, bots, bot, win, calls, logs, advance, flush }
}

test('spawner drops one matching whole stack per 10s from GUI and inventory, excluding unrelated items', async () => {
  const h = dropHarness()
  const done = h.runner.start('A', { ...defaults, durationMs: 21000 })
  await h.flush()
  assert.deepEqual(h.calls, [{ t: 0, slot: 0, button: 1, mode: 4 }])
  await h.advance(9999)
  assert.equal(h.calls.length, 1)
  await h.advance(1)
  assert.deepEqual(h.calls[1], { t: 10000, slot: 2, button: 1, mode: 4 })
  await h.advance(11000); await done
  assert.equal(h.win.slots[1].name, 'diamond')
  assert.equal(h.bot.currentWindow, null)
  assert.equal(h.bots.A.spawnerDropRunning, false)
})

test('stop during cooldown cancels immediately, and rejected GUI drop is never repeated', async () => {
  const h = dropHarness()
  const done = h.runner.start('A', defaults)
  await h.flush()
  assert.equal(h.runner.stop('A'), true)
  await done
  assert.equal(h.calls.length, 1)
  const rejected = dropHarness(false)
  const fail = rejected.runner.start('A', defaults)
  await rejected.advance(4000); await fail
  assert.equal(rejected.calls.length, 1)
  assert.match(rejected.logs.join('\n'), /server may reject GUI drops/)
})

test('a later GUI is never adopted as the spawner window', async () => {
  const h = dropHarness()
  const done = h.runner.start('A', { ...defaults, durationMs: 21000 })
  await h.flush()
  const unrelated = { id: 2, inventoryStart: 2, inventoryEnd: 4, slots: [{ name: 'bones', type: 1, count: 64 }] }
  h.bot.currentWindow = unrelated
  h.bot.emit('windowOpen', unrelated)
  await h.advance(10000)
  await done
  assert.equal(h.calls.length, 1, 'no drop from the newly opened GUI')
  assert.equal(h.bot.currentWindow, unrelated, 'cleanup must not close another GUI')
  assert.match(h.logs.join('\n'), /avoid touching a different GUI/)
  assert.equal(h.bot._client.listenerCount('set_slot'), 0)
})

test('cancelling before a scheduled operation does not send it later', async () => {
  const h = dropHarness()
  let looks = 0
  h.bot.lookAt = async () => { looks++ }
  const done = h.runner.start('A', defaults)
  h.runner.stop('A')
  await done
  assert.equal(looks, 0)
  assert.equal(h.calls.length, 0)
})

test('unrelated transaction packets do not confirm a modern optimistic drop', async () => {
  const h = dropHarness(false)
  const done = h.runner.start('A', defaults)
  await h.flush()
  h.bot._client.emit('transaction', { windowId: h.win.id, action: 999, accepted: true })
  await h.advance(4000)
  await done
  assert.equal(h.calls.length, 1)
  assert.match(h.logs.join('\n'), /not confirmed by server/)
  assert.match(h.logs.join('\n'), /0 confirmed stack/)
})

test('partial server stack updates are not counted as whole-stack drops', async () => {
  const h = dropHarness(false)
  const Item = require('prismarine-item')(h.bot.registry)
  const done = h.runner.start('A', defaults)
  await h.flush()
  h.bot._client.emit('set_slot', { windowId: h.win.id, slot: 0, item: Item.toNotch(new Item(1, 63)) })
  await h.advance(100)
  await done
  assert.equal(h.calls.length, 1)
  assert.match(h.logs.join('\n'), /0 confirmed stack/)
})

test('spawner options override defaults and refuse invalid pacing or modes', () => {
  const opts = parseOptions('"bone" duration=2min cooldown=1500ms scope=gui mode=once', defaults)
  assert.equal(opts.durationMs, 120000)
  assert.equal(opts.cooldownMs, 1500)
  assert.deepEqual(opts.terms, ['bone'])
  assert.throws(() => parseOptions('cooldown=0', defaults))
  assert.throws(() => parseOptions('mode=forever', defaults))
  assert.throws(() => parseOptions('', { ...defaults, terms: [''] }), /empty item filter/)
  assert.throws(() => parseOptions('""', defaults), /empty item filter/)
})
