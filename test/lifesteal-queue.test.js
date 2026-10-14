'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const LQ = require('../lifesteal-queue')

function makeHarness (names, opts) {
  opts = opts || {}
  const sent = []
  const bots = {}
  for (const n of names) {
    bots[n] = { bot: { entity: { position: { x: 0, y: 64, z: 0, clone () { return { x: 0, y: 64, z: 0 } } }, yaw: 0, players: {}, chat: () => {} }, chat: () => {} } }
    if (opts.botExtra) Object.assign(bots[n].bot, opts.botExtra(n))
  }
  let t = 1000000
  const env = { LIFESTEAL_TARGET_BOTS: '20', ...(opts.env || {}) }
  const banned = new Set(opts.banned || [])
  const q = LQ.createLifestealQueue({
    getBots: () => bots,
    isOnline: (e) => !!e?.bot?.entity,
    sendChat: (id, msg) => { sent.push({ id, msg }); return true },
    log: () => {},
    now: () => t,
    getEnv: () => env,
    isBanned: (id) => banned.has(id),
    ensureRoster: (missing) => { harness.rosterAsked.push(missing); return { ok: true } },
    rand: (n) => 0, // deterministic: always first of pool
    setTimer: () => ({}),
    clearTimer: () => {},
  })
  const harness = { q, bots, sent, rosterAsked: [], advance (ms) { t += ms }, env, setOnline (id, on) { if (!on) bots[id].bot.entity = null; else if (!bots[id].bot.entity) bots[id].bot.entity = { position: { x: 0, y: 64, z: 0 }, yaw: 0 } } }
  return harness
}

test('starts with 4 distinct roles and parks the rest at /warp afk', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E', 'F'])
  h.q.start()
  const s = h.q.status()
  assert.equal(s.running, true)
  const roles = Object.values(s.roles).filter(Boolean)
  assert.equal(roles.length, 4)
  assert.equal(new Set(roles).size, 4, 'roles must be distinct bots')
  // arena must not be duels or queue
  assert.ok(s.roles.arena !== s.roles.duels && s.roles.arena !== s.roles.queue)
  const duelsSent = h.sent.find(m => m.msg === '/duelsroomqueue')
  const queueSent = h.sent.find(m => m.msg === '/queue')
  const arenaSent = h.sent.find(m => m.msg === '/warp arena')
  assert.ok(duelsSent, 'a bot should send /duelsroomqueue')
  assert.ok(queueSent, 'a bot should send /queue')
  assert.ok(arenaSent, 'arena bot should send /warp arena')
  const afkSent = h.sent.filter(m => m.msg === '/warp afk')
  assert.ok(afkSent.length >= 2, 'idle bots should be parked at /warp afk')
  h.q.stop()
})

test('duels death picks a fresh random bot (replacement may be same pool)', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E'])
  h.q.start()
  const first = h.q.status().roles.duels
  assert.ok(first)
  h.q.onDeath(first)
  const second = h.q.status().roles.duels
  assert.ok(second, 'duels role should be refilled after death')
  const duelsSends = h.sent.filter(m => m.msg === '/duelsroomqueue')
  assert.ok(duelsSends.length >= 2, 'replacement should re-send /duelsroomqueue')
  h.q.stop()
})

test('queue death picks a fresh random bot', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E'])
  h.q.start()
  const first = h.q.status().roles.queue
  h.q.onDeath(first)
  assert.ok(h.q.status().roles.queue)
  assert.ok(h.sent.filter(m => m.msg === '/queue').length >= 2)
  h.q.stop()
})

test('deathban parks the tpa bot for 24h and promotes a fresh bot', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E', 'F'])
  h.q.start()
  const first = h.q.status().roles.tpa
  assert.ok(first)
  h.q.onMessage(first, 'You are deathbanned for 24 hours! You can join but not /server lifesteal')
  assert.equal(h.q.isDeathbanned(first), true)
  const second = h.q.status().roles.tpa
  // replacement happens on next tick inside markDeathbanned? force tick
  h.q.tick()
  const after = h.q.status().roles.tpa
  assert.ok(after, 'tpa role should be refilled')
  assert.notEqual(after, first, 'deathbanned bot must not keep the tpa role')
  h.q.stop()
})

test('roster maintainer asks for missing bots but never removes', () => {
  const h = makeHarness(['A', 'B'], { env: { LIFESTEAL_TARGET_BOTS: '20', LIFESTEAL_ROSTER_TICK_MS: '0' } })
  h.q.start()
  h.q.tick()
  assert.ok(h.rosterAsked.length >= 1, 'should request top-up when below target')
  assert.equal(h.rosterAsked[0], 18)
  // above target: no request
  h.rosterAsked.length = 0
  for (let i = 0; i < 30; i++) h.bots['X' + i] = { bot: { entity: {} } }
  h.advance(70000)
  h.q.tick()
  assert.equal(h.rosterAsked.length, 0, 'must never remove when above target')
  h.q.stop()
})

test('isDeathbanText matches lifesteal wording', () => {
  assert.equal(LQ.isDeathbanText('You have been deathbanned! Expires in 24 hours'), true)
  assert.equal(LQ.isDeathbanText('banned for 24 hours'), true)
  assert.equal(LQ.isDeathbanText('welcome to lifesteal'), false)
})

test('arena bot is never the duels or queue bot', () => {
  for (let i = 0; i < 5; i++) {
    const h = makeHarness(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
    h.q.start()
    const s = h.q.status().roles
    assert.ok(s.arena !== s.duels && s.arena !== s.queue, `run ${i}: arena distinct`)
    h.q.stop()
  }
})

test('banned bots are excluded from roles and replaced via /new-gen', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E', 'F'], { banned: ['A', 'B'] })
  h.q.start()
  const s = h.q.status()
  for (const holder of Object.values(s.roles).filter(Boolean)) {
    assert.ok(holder !== 'A' && holder !== 'B', 'banned bots must not hold roles')
  }
  h.q.tick()
  h.advance(70000)
  h.q.tick()
  // 6 total - 2 banned = 4 effective < 20 target -> top-up asked
  assert.ok(h.rosterAsked.length >= 1, 'banned bots should count as missing')
  h.q.stop()
})

test('onBan drops the role, orders one replacement, and refills immediately', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E', 'F'])
  h.q.start()
  const first = h.q.status().roles.duels
  assert.ok(first)
  h.env.LIFESTEAL_ROSTER_TICK_MS = '999999999'
  h.rosterAsked.length = 0
  h.q.onBan(first, 'banned: test wave')
  assert.equal(h.rosterAsked.length, 1, 'a ban should order exactly one /new-gen replacement')
  assert.equal(h.rosterAsked[0], 1)
  assert.ok(h.q.status().roles.duels, 'duels role should be refilled from usable bots')
  h.q.stop()
})

test('lifestealTorRestartCmd defaults to restart-tor.sh --tor-only (brew has no ControlPort 9051)', () => {
  const expected = 'sudo -n bash ./scripts/restart-tor.sh --tor-only'
  assert.equal(LQ.lifestealTorRestartCmd({}), expected)
  assert.equal(LQ.lifestealTorRestartCmd({ LIFESTEAL_TOR_RESTART_CMD: 'systemctl restart tor' }), 'systemctl restart tor')
  assert.equal(LQ.lifestealTorRestartCmd({ LIFESTEAL_TOR_RESTART_CMD: '  ' }), expected)
  // Homebrew's Tor is explicitly NOT the fleet: no control port -> ECONNREFUSED.
  assert.notEqual(LQ.lifestealTorRestartCmd({}), 'brew services restart tor')
})
