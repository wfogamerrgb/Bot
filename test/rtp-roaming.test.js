'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createRtpRoaming } = require('../rtp-roaming')
function vector(x, y, z) { return { x, y, z, floored() { return vector(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) }, offset(dx, dy, dz) { return vector(this.x + dx, this.y + dy, this.z + dz) } } }
function harness(env = {}) {
  let time = 0
  const timers = new Map(), logs = [], chats = [], lines = []
  const bot = new EventEmitter()
  Object.assign(bot, { entity: { position: vector(0, 64, 0) }, game: { dimension: 'overworld', minY: 48, height: 48 }, food: 20, inventory: { slots: [], items: () => [] }, registry: { blocksByName: { chest: { id: 1 }, furnace: { id: 2 } }, foodsByName: {} }, players: {}, chat(cmd) { chats.push(cmd) }, deactivateItem() {}, world: { getColumn: () => ({}) }, findBlocks: () => [], blockAt: () => ({ name: 'furnace' }) })
  const bots = { A: { bot }, B: { bot: {} } }
  const manager = createRtpRoaming({ bots, env: () => env, online: e => !!e?.bot?.entity && !e.offline, busy: e => !!e.busy, io: { appendFileSync: (_file, text) => lines.push(text) }, now: () => time, random: () => 0, setTimer(fn, delay) { const t = { fn, at: time + delay }; timers.set(t, t); return t }, clearTimer: t => timers.delete(t), log: (id, text) => logs.push([id, text]), yieldTurn: async () => {} })
  async function advance(ms) { const end = time + ms; for (;;) { const next = [...timers.values()].filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0]; if (!next) break; timers.delete(next); time = next.at; await next.fn(); await Promise.resolve() } time = end }
  return { manager, bot, bots, timers, logs, chats, lines, advance, env }
}
test('existing connected bots only; duplicate starts refused and initial/periodic arrivals append local text', async () => {
  const h = harness()
  assert.equal(h.manager.start('Absent').ok, false)
  assert.equal(h.manager.start('B').ok, false)
  assert.equal(h.manager.start('A').ok, true)
  assert.equal(h.manager.start('A').ok, false)
  assert.deepEqual(h.chats, ['/rtp world world'])
  h.bot.entity.position = vector(200, 68, -42)
  await h.advance(1500)
  assert.match(h.lines[0], /\tA\toverworld\t200, 68, -42\n$/)
  await h.advance(33300)
  h.bot.entity.position = vector(400, 70, 80)
  await h.advance(1500)
  assert.equal(h.lines.length, 2)
  h.manager.stop('A')
  assert.equal(h.timers.size, 0)
  assert.equal(h.bot.listenerCount('forcedMove'), 0)
  assert.equal(h.bots.A.rtpRunning, false)
})
test('rejected RTP does not log old location; disconnect/death cancel every timer', async () => {
  for (const event of ['end', 'death', 'kicked']) {
    const h = harness(); h.manager.start('A'); await h.advance(31000)
    assert.equal(h.lines.length, 0)
    h.bot.emit(event)
    assert.equal(h.manager.active('A'), false)
    assert.equal(h.timers.size, 0)
  }
})
test('base discovery pauses RTP, nearby fleet names are ignored, and no alerts leave local logs', async () => {
  const h = harness({ BASE_SCAN_RADIUS: '16', BASE_SCAN_INTERVAL_MS: '2000', PLAYER_PROXIMITY_INTERVAL_MS: '2000' })
  h.manager.start('A')
  h.bot.entity.position = vector(100, 64, 0)
  h.bot.findBlocks = () => [vector(100, 64, 0), vector(101, 64, 0), vector(102, 64, 0), vector(103, 64, 0)]
  h.bot.players = { b: { entity: { position: vector(101, 64, 0) } }, Human: { entity: { position: vector(102, 64, 0) } } }
  await h.advance(2000)
  assert.ok(h.logs.some(([, text]) => text.includes('Possible base')))
  assert.ok(h.logs.some(([, text]) => text.includes('Player nearby: Human')))
  assert.ok(!h.logs.some(([, text]) => text.includes('Player nearby: b')))
  await h.advance(35000)
  assert.equal(h.chats.length, 1, 'base hold suppresses periodic teleport')
  h.manager.stop('A')
})
test('busy routines block roam start; cancellation prevents async scan discovery and food consumption', async () => {
  const h = harness()
  h.bots.A.busy = true; assert.equal(h.manager.start('A').ok, false)
  h.bots.A.busy = false; h.manager.start('A')
  h.bot.entity.position = vector(100, 64, 0); await h.advance(1500)
  let yields = 0
  h.bot.findBlocks = () => [vector(100, 64, 0), vector(101, 64, 0), vector(102, 64, 0), vector(103, 64, 0)]
  // End during scan's first chunk query; no stale report after the yield.
  h.bot.findBlocks = () => { yields++; h.manager.stop('A'); return [vector(100, 64, 0)] }
  await h.manager.scan(h.manager.sessions.get('A'))
  assert.equal(yields, 1)
  assert.ok(!h.logs.some(([, text]) => text.includes('Possible base')))
})
test('roam tuning is reread between requests and a stopped session never teleports again', async () => {
  const h = harness(); h.manager.start('A'); h.env.RTP_COMMAND = '/rtp next'; await h.advance(34800)
  assert.equal(h.chats[1], '/rtp next')
  h.manager.stop('A'); await h.advance(100000)
  assert.equal(h.chats.length, 2)
})
