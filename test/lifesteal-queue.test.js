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
  let generated = 0
  const q = LQ.createLifestealQueue({
    getBots: () => bots,
    isOnline: (e) => !!e?.bot?.entity,
    sendChat: (id, msg) => { sent.push({ id, msg }); return true },
    log: () => {},
    now: () => t,
    getEnv: () => env,
    isBanned: (id) => banned.has(id),
    ensureRoster: (missing) => {
      harness.rosterAsked.push(missing)
      // Mirror the real hook: names are saved to BOT_NAMES immediately, long
      // before their staggered connects land in the bots map.
      const names = []
      for (let i = 0; i < missing; i++) names.push(`Gen${++generated}`)
      env.BOT_NAMES = [env.BOT_NAMES, ...names].filter(Boolean).join(',')
      return { ok: true, names }
    },
    rand: (n) => 0, // deterministic: always first of pool
    setTimer: () => ({}),
    clearTimer: () => {},
    // No real-time pulses: tests drive tick() manually on the fake clock.
    setPulse: () => null,
    clearPulse: () => {},
  })
  const harness = { q, bots, banned, sent, rosterAsked: [], advance (ms) { t += ms }, env, setOnline (id, on) { if (!on) bots[id].bot.entity = null; else if (!bots[id].bot.entity) bots[id].bot.entity = { position: { x: 0, y: 64, z: 0 }, yaw: 0 } } }
  return harness
}

test('starts with 4 distinct roles and parks the rest at /warp afk', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E', 'F'])
  h.q.start()
  const s = h.q.status()
  assert.equal(s.running, true)
  const roles = Object.values(s.roles).flat()
  assert.equal(roles.length, 4)
  assert.equal(new Set(roles).size, 4, 'roles must be distinct bots')
  // arena must not be duels or queue
  for (const id of s.roles.arena) assert.ok(!s.roles.duels.includes(id) && !s.roles.queue.includes(id))
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
  const first = h.q.status().roles.duels[0]
  assert.ok(first)
  h.q.onDeath(first)
  const second = h.q.status().roles.duels[0]
  assert.ok(second, 'duels role should be refilled after death')
  const duelsSends = h.sent.filter(m => m.msg === '/duelsroomqueue')
  assert.ok(duelsSends.length >= 2, 'replacement should re-send /duelsroomqueue')
  h.q.stop()
})

test('queue death picks a fresh random bot', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E'])
  h.q.start()
  const first = h.q.status().roles.queue[0]
  h.q.onDeath(first)
  assert.ok(h.q.status().roles.queue[0])
  assert.ok(h.sent.filter(m => m.msg === '/queue').length >= 2)
  h.q.stop()
})

test('deathban parks the tpa bot for 24h and promotes a fresh bot', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E', 'F'])
  h.q.start()
  const first = h.q.status().roles.tpa[0]
  assert.ok(first)
  h.q.onMessage(first, 'You are deathbanned for 24 hours! You can join but not /server lifesteal')
  assert.equal(h.q.isDeathbanned(first), true)
  const second = h.q.status().roles.tpa[0]
  // replacement happens on next tick inside markDeathbanned? force tick
  h.q.tick()
  const after = h.q.status().roles.tpa[0]
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
    for (const id of s.arena) assert.ok(!s.duels.includes(id) && !s.queue.includes(id), `run ${i}: arena distinct`)
    h.q.stop()
  }
})

test('banned bots are excluded from roles and replaced via /new-gen', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E', 'F'], { banned: ['A', 'B'] })
  h.q.start()
  const s = h.q.status()
  for (const holder of Object.values(s.roles).flat()) {
    assert.ok(holder !== 'A' && holder !== 'B', 'banned bots must not hold roles')
  }
  h.q.tick()
  h.advance(70000)
  h.q.tick()
  // 6 total - 2 banned = 4 effective < 20 target -> top-up asked
  assert.ok(h.rosterAsked.length >= 1, 'banned bots should count as missing')
  h.q.stop()
})

test('saved-but-unconnected names count toward the target — a pending wave is never duplicated', () => {
  const h = makeHarness(['A', 'B'], { env: { LIFESTEAL_TARGET_BOTS: '5', LIFESTEAL_ROSTER_TICK_MS: '0' } })
  h.q.start()
  h.q.tick()
  h.advance(70000)
  h.q.tick()
  h.advance(70000)
  h.q.tick()
  assert.deepEqual(h.rosterAsked, [3], 'later roster ticks must see names already saved to BOT_NAMES')
  h.q.stop()
})

test('a ban orders exactly one replacement even when the roster tick is due', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E'], { env: { LIFESTEAL_TARGET_BOTS: '5', LIFESTEAL_ROSTER_TICK_MS: '0' } })
  h.q.start()
  h.banned.add('A')
  h.q.onBan('A', 'banned: test wave')
  h.q.tick()
  h.advance(70000)
  h.q.tick()
  assert.deepEqual(h.rosterAsked, [1], 'the fresh name from onBan satisfies the roster — exactly one /new-gen order')
  h.q.stop()
})

test('onBan drops the role, orders one replacement, and refills immediately', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E', 'F'])
  h.q.start()
  const first = h.q.status().roles.duels[0]
  assert.ok(first)
  h.env.LIFESTEAL_ROSTER_TICK_MS = '999999999'
  h.rosterAsked.length = 0
  h.q.onBan(first, 'banned: test wave')
  assert.equal(h.rosterAsked.length, 1, 'a ban should order exactly one /new-gen replacement')
  assert.equal(h.rosterAsked[0], 1)
  assert.ok(h.q.status().roles.duels[0], 'duels role should be refilled from usable bots')
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

// Chat-based ban/deathban detection is spoofable: any player can type the exact
// server wording. Two gates defend against that — name-shaped lines are never
// believed, and plain-looking lines are only believed inside a trust window
// (first minutes of a session, or right after a real death/kick).
test('looksLikePlayerChat flags every chat shape players can type', () => {
  assert.equal(LQ.looksLikePlayerChat('Steve: You are deathbanned for 24 hours!'), true)
  assert.equal(LQ.looksLikePlayerChat('<Steve> You are deathbanned for 24 hours!'), true)
  assert.equal(LQ.looksLikePlayerChat('[MVP+] Steve: Kicked: {"color":"red"}'), true)
  assert.equal(LQ.looksLikePlayerChat('[VIP] <Steve> Kicked: {"color":"red","text":"x"}'), true)
  assert.equal(LQ.looksLikePlayerChat('Steve » Kicked: whatever'), true)
  // real server notices carry no sender prefix
  assert.equal(LQ.looksLikePlayerChat('You are deathbanned for 24 hours! You can join but not /server lifesteal'), false)
  // even a bare "Kicked: {…}" line is name-shaped ("Kicked" reads as a sender)
  // and must never be believed from chat — real kicks arrive as kick packets,
  // which onKick always trusts.
  assert.equal(LQ.looksLikePlayerChat('Kicked: {"color":"red","text":"You are not logged into your Minecraft account."}'), true)
})

test('typed chat cannot fake a deathban, and plain text is only believed in the trust window', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E'])
  h.q.start()
  const first = h.q.status().roles.tpa[0]
  assert.ok(first)
  // Player-shaped chat is never believed, even moments after start (the widest
  // trust window) — this is the spoof the filter exists for.
  h.q.onMessage(first, 'MVPSteve: You are deathbanned for 24 hours! You can join but not /server lifesteal')
  assert.equal(h.q.isDeathbanned(first), false, 'typed chat must never deathban')
  h.q.onMessage(first, '<MVPSteve> You are deathbanned for 24 hours! You can join but not /server lifesteal')
  assert.equal(h.q.isDeathbanned(first), false, 'angle-bracket chat must never deathban')
  // Plain-looking text is believed right after start (trust window open).
  h.q.onMessage(first, 'You are deathbanned for 24 hours! You can join but not /server lifesteal')
  assert.equal(h.q.isDeathbanned(first), true, 'genuine notice inside the trust window is believed')
  // A different bot far past its trust window with no real event: the same
  // plain text is ignored — after the window only real death/kick packets
  // reopen belief.
  const second = h.q.status().roles.queue[0]
  assert.ok(second)
  h.advance(h.env.LIFESTEAL_TRUST_WINDOW_MS ? Number(h.env.LIFESTEAL_TRUST_WINDOW_MS) + 1000 : 11 * 60 * 1000)
  h.q.onMessage(second, 'You are deathbanned for 24 hours! You can join but not /server lifesteal')
  assert.equal(h.q.isDeathbanned(second), false, 'stale plain text outside the trust window is ignored')
  // A real death reopens the window: the deathban notice that follows counts.
  h.q.onDeath(second)
  h.q.onMessage(second, 'You are deathbanned for 24 hours! You can join but not /server lifesteal')
  assert.equal(h.q.isDeathbanned(second), true, 'notice right after a real death is believed')
  h.q.stop()
})

test('a real kick packet always counts, with no trust window', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E'])
  h.q.start()
  const first = h.q.status().roles.duels[0]
  assert.ok(first)
  h.advance(60 * 60 * 1000) // an hour in — far past any window
  h.q.onKick(first, 'You are deathbanned for 24 hours! You can join but not /server lifesteal')
  assert.equal(h.q.isDeathbanned(first), true, 'kick packets are unspoofable and always believed')
  h.q.stop()
})

// ── configurable role counts ───────────────────────────────────────────────
test('readConfig parses role counts — 1 each by default, 0 disables, bad input falls back', () => {
  const def = LQ.readConfig({})
  assert.equal(def.duelsBots, 1)
  assert.equal(def.queueBots, 1)
  assert.equal(def.arenaBots, 1)
  assert.equal(def.tpaBots, 1)
  assert.equal(def.soloRepeatMs, 15000)
  const custom = LQ.readConfig({
    LIFESTEAL_DUELS_BOTS: '2',
    LIFESTEAL_QUEUE_BOTS: '0',
    LIFESTEAL_ARENA_BOTS: '4',
    LIFESTEAL_TPA_BOTS: '9',
    LIFESTEAL_SOLO_REPEAT_MS: '2500',
  })
  assert.deepEqual(
    [custom.duelsBots, custom.queueBots, custom.arenaBots, custom.tpaBots, custom.soloRepeatMs],
    [2, 0, 4, 9, 2500]
  )
  assert.equal(LQ.readConfig({ LIFESTEAL_TPA_BOTS: 'many' }).tpaBots, 1, 'unparseable falls back to the default')
  assert.equal(LQ.readConfig({ LIFESTEAL_TPA_BOTS: '-3' }).tpaBots, 0, 'negative clamps to 0 (disabled)')
})

test('role counts decide how many bots hold each role — more /tpa bots, 0 disables', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'], {
    env: { LIFESTEAL_TPA_BOTS: '3', LIFESTEAL_DUELS_BOTS: '2', LIFESTEAL_QUEUE_BOTS: '0' },
  })
  h.q.start()
  const s = h.q.status()
  assert.equal(s.roles.tpa.length, 3, 'three tpa bots')
  assert.equal(new Set(s.roles.tpa).size, 3, 'tpa holders are distinct bots')
  assert.equal(s.roles.duels.length, 2, 'two duels bots')
  assert.equal(s.roles.queue.length, 0, 'a 0 count disables the role')
  assert.equal(s.roles.arena.length, 1)
  assert.ok(!h.sent.some(m => m.msg === '/queue'), 'no bot sends /queue when the role is disabled')
  const all = Object.values(s.roles).flat()
  assert.equal(new Set(all).size, all.length, 'a bot never holds two roles')
  h.q.stop()
})

test('lowering a count live releases the extra holders back to idle', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], { env: { LIFESTEAL_TPA_BOTS: '4' } })
  h.q.start()
  assert.equal(h.q.status().roles.tpa.length, 4)
  const before = new Set(h.q.status().roles.tpa)
  h.env.LIFESTEAL_TPA_BOTS = '1'
  h.advance(4000)
  h.q.tick()
  const after = h.q.status().roles.tpa
  assert.equal(after.length, 1, 'only one tpa bot remains')
  assert.ok(before.has(after[0]), 'the remaining holder is one of the original four')
  const parked = h.sent.filter(m => m.msg === '/warp afk').map(m => m.id)
  assert.ok(parked.length >= 3, 'released bots are parked at the AFK warp')
  for (const id of after) assert.ok(!parked.includes(id), 'the kept holder is not parked')
  h.q.stop()
})

// ── standalone routines (/tpa-roundrobin, /duelsroomspam, /queuespam,
//    /warp-arena, /afk-park) ───────────────────────────────────────────────
test('standalone tpa-roundrobin runs on N bots, never creates bots, and is mutually exclusive with /lifesteal-start', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E'], { env: { LIFESTEAL_ROSTER_TICK_MS: '0' } })
  assert.equal(h.q.start().ok, true)
  assert.equal(h.q.startSolo('tpa', 2).ok, false, 'solo refuses while the managed loop runs')
  h.q.stop()
  h.rosterAsked.length = 0 // the managed phase legitimately ordered a top-up

  const r = h.q.startSolo('tpa', 2)
  assert.equal(r.ok, true)
  h.q.tick()
  const s = h.q.status()
  assert.equal(s.running, true)
  assert.deepEqual(s.solo, { role: 'tpa', count: 2 })
  assert.equal(s.roles.tpa.length, 2, 'exactly the requested count runs the routine')
  assert.equal(new Set(s.roles.tpa).size, 2)
  h.advance(70000)
  h.q.tick()
  assert.equal(h.rosterAsked.length, 0, 'a standalone routine never orders /new-gen')
  assert.equal(h.q.start().ok, false, '/lifesteal-start refuses while a standalone routine runs')
  assert.equal(h.q.stopSolo().ok, true)
  assert.equal(h.q.status().running, false)
  assert.equal(h.q.status().solo, null)
  assert.equal(h.q.stopSolo().ok, false, 'stopping twice reports it is not running')
})

test('standalone tpa spam reaches visible players round-robin and survives a deathban', () => {
  const players = { Alice: {}, Bob: {} }
  const h = makeHarness(['A', 'B', 'C'], {
    env: { LIFESTEAL_TPA_BOTS: '2', LIFESTEAL_TPA_INTERVAL_MS: '1000', LIFESTEAL_TPA_COOLDOWN_MS: '0' },
    botExtra: () => ({ entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, players }, players }),
  })
  h.q.startSolo('tpa', 2)
  h.advance(2000)
  h.q.tick()
  const tpaSends = h.sent.filter(m => m.msg.startsWith('/tpa '))
  assert.ok(tpaSends.length >= 2, 'both tpa bots spam /tpa')
  assert.deepEqual([...new Set(tpaSends.map(m => m.id))].sort(), ['A', 'B'])
  // A deathbanned holder is dropped and refilled from the remaining bots.
  h.q.onMessage('A', 'You are deathbanned for 24 hours! You can join but not /server lifesteal')
  const s = h.q.status()
  assert.equal(s.roles.tpa.length, 2, 'the routine refills from usable bots')
  assert.ok(!s.roles.tpa.includes('A'), 'deathbanned bot holds no role')
  assert.equal(h.rosterAsked.length, 0, 'still no /new-gen in standalone mode')
  h.q.stop()
})

test('standalone duelsroomspam re-sends on the solo repeat cadence', () => {
  const h = makeHarness(['A', 'B', 'C'], { env: { LIFESTEAL_SOLO_REPEAT_MS: '5000' } })
  h.q.startSolo('duels', 1)
  const count = () => h.sent.filter(m => m.msg === '/duelsroomqueue').length
  assert.equal(count(), 1, 'assignment sends once')
  h.advance(2000)
  h.q.tick()
  assert.equal(count(), 1, 'still inside the repeat window')
  h.advance(4000)
  h.q.tick()
  assert.equal(count(), 2, 're-sent once the cadence elapsed')
  h.q.stop()
})

test('standalone queuespam and warp-arena run their own routine on the requested count', () => {
  const h = makeHarness(['A', 'B', 'C', 'D'])
  h.q.startSolo('queue', 2)
  assert.deepEqual(h.q.status().roles.queue.slice().sort(), ['A', 'B'])
  assert.equal(h.sent.filter(m => m.msg === '/queue').length, 2)
  assert.ok(!h.sent.some(m => m.msg === '/warp arena'), 'queue solo never touches the arena')
  h.q.stopSolo()

  h.sent.length = 0
  h.q.startSolo('arena', 1)
  assert.equal(h.q.status().roles.arena.length, 1)
  assert.ok(h.sent.some(m => m.msg === '/warp arena'), 'arena solo warps to the arena')
  assert.ok(!h.sent.some(m => m.msg === '/queue' || m.msg === '/duelsroomqueue'), 'arena solo runs only its own routine')
  h.q.stopSolo()

  const bad = h.q.startSolo('nope', 1)
  assert.equal(bad.ok, false)
  assert.match(bad.error, /unknown routine/)
})

test('standalone afk-park parks the requested count once — sent once, never spammed', () => {
  const h = makeHarness(['A', 'B', 'C', 'D', 'E'])
  h.q.startSolo('afk', 2)
  const parked = () => h.sent.filter(m => m.msg === '/warp afk')
  assert.equal(parked().length, 2, 'exactly the requested count is parked')
  h.advance(4000)
  h.q.tick()
  assert.equal(parked().length, 2, 'the AFK warp is sent once per bot, not spammed')
  h.q.stopSolo()
})

test('a ban in a standalone routine drops the role but never orders a /new-gen replacement', () => {
  const h = makeHarness(['A', 'B', 'C', 'D'], { env: { LIFESTEAL_ROSTER_TICK_MS: '0' } })
  h.q.startSolo('queue', 1)
  assert.equal(h.q.status().roles.queue[0], 'A')
  h.banned.add('A')
  h.q.onBan('A', 'banned: test wave')
  assert.equal(h.rosterAsked.length, 0, 'standalone routines never create accounts')
  assert.equal(h.q.status().roles.queue[0], 'B', 'the routine refills from the bots already online')
  h.advance(70000)
  h.q.tick()
  assert.equal(h.rosterAsked.length, 0, 'roster top-up stays off in standalone mode')
  h.q.stop()
})
