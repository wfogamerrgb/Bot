'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const K = require('../kos')

// Fake bots + fake clock: the module takes bots, clock, timers and settings
// through deps, so the pacing rules are deterministic here.
function makeHarness (opts = {}) {
  const env = { ...(opts.env || {}) }
  const protectedNames = new Set((opts.protected || []).map(n => String(n).toLowerCase()))
  const bots = {}
  const attacks = [] // { id, target, at }
  let t = 1000000
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const makeBot = (id) => {
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      players: {},
      entities: {},
      inventory: { slots: {}, items: () => [] },
      heldItem: null,
      equipped: [],
      looked: [],
      equip: async (item, dest) => { bot.equipped.push([item.name, dest]); bot.heldItem = item },
      unequip: async () => {},
      lookAt: async (pos) => { bot.looked.push(pos) },
      attack: (ent) => { attacks.push({ id, target: ent.username || ent.name, at: t }) },
      clearControlStates () {},
      deactivateItem () {},
      pathfinder: { stop () {} },
    }
    return bot
  }
  for (const id of opts.bots || ['A', 'B', 'C']) bots[id] = { bot: makeBot(id) }
  const q = K.createKos({
    getBots: () => bots,
    isProtectedName: (name) => protectedNames.has(String(name).toLowerCase()),
    pickBestWeapon: () => null,
    log: () => {},
    now: () => t,
    getEnv: () => env,
    rand: opts.rand || (() => 0),
    setPulse: () => null,
    clearPulse: () => {},
  })
  return {
    q, bots, env, attacks,
    player (botId, name, pos = { x: 1, y: 64, z: 0 }) {
      bots[botId].bot.players[name] = { entity: { username: name, height: 1.8, position: pos } }
    },
    async step (ms = 0) { t += ms; q.tick(); await flush() },
    async start (id) { const ok = q.start(id); await flush(); return ok },
  }
}

test('readConfig: KOS pacing defaults, overrides, and clamping', () => {
  const def = K.readConfig({})
  assert.equal(def.engageDelayMs, 500)
  assert.equal(def.staggerMs, 550)
  assert.equal(def.staggerJitterMs, 50)
  assert.equal(def.botCooldownMs, 600)
  assert.equal(def.botCooldownJitterMs, 100)
  assert.equal(def.tickMs, 50)
  const custom = K.readConfig({ KOS_ENGAGE_DELAY_MS: '0', KOS_STAGGER_MS: '250', KOS_STAGGER_JITTER_MS: '25', KOS_BOT_COOLDOWN_MS: '900', KOS_BOT_COOLDOWN_JITTER_MS: '10', KOS_TICK_MS: '75' })
  assert.deepEqual(
    [custom.engageDelayMs, custom.staggerMs, custom.staggerJitterMs, custom.botCooldownMs, custom.botCooldownJitterMs, custom.tickMs],
    [0, 250, 25, 900, 10, 75]
  )
  assert.equal(K.readConfig({ KOS_STAGGER_MS: 'fast' }).staggerMs, 550, 'unparseable falls back to the default')
  assert.equal(K.readConfig({ KOS_STAGGER_MS: '-5' }).staggerMs, 0, 'negative clamps to 0')
})

test('attacks only unprotected players — never the TPA main player, fleet bots, trusted names, or mobs', async () => {
  const h = makeHarness({
    bots: ['A', 'B'],
    protected: ['Main', 'B', 'Ally'],
    env: { KOS_ENGAGE_DELAY_MS: '0', KOS_STAGGER_MS: '0', KOS_BOT_COOLDOWN_MS: '0' },
  })
  h.player('A', 'Main', { x: 1, y: 64, z: 0 })
  h.player('A', 'B', { x: 1, y: 64, z: 1 })
  h.player('A', 'Ally', { x: 1, y: 64, z: 2 })
  h.player('A', 'Random', { x: 2, y: 64, z: 0 })
  // A hostile mob in reach is still never a KOS target — /kos is for people.
  h.bots.A.bot.entities = { 7: { type: 'mob', name: 'zombie', position: { x: 1, y: 64, z: 3 } } }
  await h.start('A')
  assert.deepEqual(h.attacks.map(a => a.target), ['Random'], 'only the unprotected player is ever hit')
})

test('a protection lookup that throws counts as protected — when unsure, never swing', async () => {
  const bots = { A: { bot: { entity: { position: { x: 0, y: 64, z: 0 } }, players: { Random: { entity: { username: 'Random', position: { x: 1, y: 64, z: 0 } } } }, attack: () => { throw new Error('must not attack') } } } }
  const q = K.createKos({
    getBots: () => bots,
    isProtectedName: () => { throw new Error('lookup exploded') },
    pickBestWeapon: () => null,
    log: () => {},
    now: () => 1000,
    getEnv: () => ({ KOS_ENGAGE_DELAY_MS: '0', KOS_STAGGER_MS: '0', KOS_BOT_COOLDOWN_MS: '0' }),
    setPulse: () => null,
    clearPulse: () => {},
  })
  assert.equal(q.start('A'), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(q.status().targets.length, 0, 'no target was ever engaged')
})

test('the swarm holds for KOS_ENGAGE_DELAY_MS after the target comes in reach (the /tpaccept moment)', async () => {
  const h = makeHarness({
    bots: ['A', 'B'],
    env: { KOS_ENGAGE_DELAY_MS: '500', KOS_STAGGER_MS: '550', KOS_BOT_COOLDOWN_MS: '625' },
  })
  h.player('A', 'Random')
  h.player('B', 'Random')
  await h.start('A')
  await h.start('B')
  assert.equal(h.attacks.length, 0, 'no hit while the target just arrived')
  await h.step(300)
  assert.equal(h.attacks.length, 0, 'still inside the 0.5s engage delay')
  await h.step(300)
  assert.equal(h.attacks.length, 1, 'exactly one hit once the delay elapsed — the swarm does not dump every swing at once')
})

test('fleet hits are spread past the 10-tick immunity window and rotate across bots', async () => {
  const h = makeHarness({
    bots: ['A', 'B', 'C'],
    env: { KOS_ENGAGE_DELAY_MS: '0', KOS_STAGGER_MS: '550', KOS_BOT_COOLDOWN_MS: '100' },
  })
  h.player('A', 'Random')
  h.player('B', 'Random')
  h.player('C', 'Random')
  await h.start('A')
  await h.start('B')
  await h.start('C')
  for (let i = 0; i < 50; i++) await h.step(50) // ~2.5s of 50ms ticks
  const times = h.attacks.map(a => a.at)
  assert.ok(times.length >= 3, `the swarm keeps hitting (got ${times.length})`)
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1]
    assert.ok(gap >= 550, `hit ${i} landed only ${gap}ms after the previous one — inside the 10-tick immunity window, wasted`)
  }
  const attackers = [...new Set(h.attacks.map(a => a.id))].sort()
  assert.deepEqual(attackers, ['A', 'B', 'C'], 'every armed bot gets a swing — the hits rotate, none starves')
})

test('each bot waits KOS_BOT_COOLDOWN_MS between its own hits (full weapon strength)', async () => {
  const h = makeHarness({
    bots: ['A'],
    env: { KOS_ENGAGE_DELAY_MS: '0', KOS_STAGGER_MS: '0', KOS_BOT_COOLDOWN_MS: '625' },
  })
  h.player('A', 'Random')
  await h.start('A')
  assert.equal(h.attacks.length, 1)
  await h.step(300)
  assert.equal(h.attacks.length, 1, 'own recharge is not complete yet')
  await h.step(400)
  assert.equal(h.attacks.length, 2, 'swings again once its own weapon has fully recharged')
})

test('a target that leaves and comes back (another /tpaccept) gets the engage delay again', async () => {
  const h = makeHarness({
    bots: ['A'],
    env: { KOS_ENGAGE_DELAY_MS: '500', KOS_STAGGER_MS: '550', KOS_BOT_COOLDOWN_MS: '625' },
  })
  h.player('A', 'Random')
  await h.start('A')
  await h.step(600)
  assert.equal(h.attacks.length, 1, 'first engagement completes')
  delete h.bots.A.bot.players.Random
  await h.step(31000) // out of reach long enough to be forgotten
  h.player('A', 'Random')
  await h.step(0)
  assert.equal(h.attacks.length, 1, 'no instant hit when they land — the grace applies again')
  await h.step(500)
  assert.equal(h.attacks.length, 2, 'the swarm resumes after the engage delay')
})

test('per-hit cooldown jitter: the swing lands at base + jitter, never before the recharge', async () => {
  const h = makeHarness({
    bots: ['A'],
    rand: () => 0.5, // deterministic jitter: floor(0.5 * 101) = 50ms
    env: { KOS_ENGAGE_DELAY_MS: '0', KOS_STAGGER_MS: '0', KOS_STAGGER_JITTER_MS: '0', KOS_BOT_COOLDOWN_MS: '600', KOS_BOT_COOLDOWN_JITTER_MS: '100' },
  })
  h.player('A', 'Random')
  await h.start('A')
  assert.equal(h.attacks.length, 1, 'first hit is immediate')
  await h.step(300)
  assert.equal(h.attacks.length, 1, 'inside the 600ms minimum recharge')
  await h.step(300) // 600ms elapsed — the base cooldown, but the drawn jitter put this swing at 650
  assert.equal(h.attacks.length, 1, 'the drawn jitter pushed this swing past the base cooldown')
  await h.step(100) // 700ms
  assert.equal(h.attacks.length, 2, 'lands once base + jitter elapsed — and not a tick earlier')
})

test('fleet hit slot jitter: gaps stay at or above the immunity window but never periodic', async () => {
  const h = makeHarness({
    bots: ['A'],
    rand: () => 1, // deterministic jitter: always the maximum (100ms)
    env: { KOS_ENGAGE_DELAY_MS: '0', KOS_STAGGER_MS: '550', KOS_STAGGER_JITTER_MS: '100', KOS_BOT_COOLDOWN_MS: '0', KOS_BOT_COOLDOWN_JITTER_MS: '0' },
  })
  h.player('A', 'Random')
  await h.start('A')
  for (let i = 0; i < 30; i++) await h.step(50)
  const times = h.attacks.map(a => a.at)
  assert.ok(times.length >= 2, `the bot keeps hitting (got ${times.length})`)
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1]
    assert.ok(gap >= 550, `hit ${i} landed only ${gap}ms after the previous — inside the 10-tick immunity window, wasted`)
    assert.ok(gap <= 650, `hit ${i} landed ${gap}ms after the previous — beyond the drawn slot`)
  }
})

test('start/stop lifecycle: refuses unspawned bots, toggles cleanly, stopAll clears', async () => {
  const h = makeHarness({ bots: ['A', 'B'] })
  assert.equal(h.q.start('Missing'), false, 'no such bot')
  h.bots.A.bot.entity = null
  assert.equal(h.q.start('A'), false, 'refuses a bot that is not spawned')
  h.bots.A.bot.entity = { position: { x: 0, y: 64, z: 0 } }
  assert.equal(await h.start('A'), true)
  assert.equal(h.q.isRunning('A'), true)
  assert.equal(h.q.stop('A'), true)
  assert.equal(h.q.isRunning('A'), false)
  assert.equal(h.q.stop('A'), false, 'stopping twice reports it was not running')
  await h.start('A')
  await h.start('B')
  assert.deepEqual(h.q.status().running.sort(), ['A', 'B'])
  h.q.stopAll()
  assert.deepEqual(h.q.status().running, [])
})
