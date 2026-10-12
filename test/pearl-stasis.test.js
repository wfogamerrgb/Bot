'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { TRIGGER_MESSAGE, createPearlStasis } = require('../pearl-stasis')

function harness (names = ['A']) {
  let time = 10000
  const calls = [], logs = [], bots = {}
  for (const id of names) {
    const block = { name: 'oak_trapdoor', position: new Vec3(1, 64, 1) }
    const bot = new EventEmitter()
    Object.assign(bot, {
      entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62 },
      game: { dimension: 'overworld' }, _client: { state: 'play' },
      findBlocks: () => [block.position], blockAt: () => block,
      canSeeBlock: () => true, activateBlock: async b => { calls.push([id, b]) },
      setControlState () { assert.fail('Movement forbidden') },
      pathfinder: { setGoal () { assert.fail('Pathfinding forbidden') }, goto () { assert.fail('Pathfinding forbidden') } },
      chat () { assert.fail('Chat/warps forbidden') }
    })
    bots[id] = { bot, host: 'server', port: 25565, connectionState: 'online', block }
  }
  const responder = createPearlStasis({ getBots: () => bots, logFor: (id, msg) => logs.push([id, msg]), now: () => time })
  return { bots, calls, logs, responder, advance: ms => { time += ms } }
}

test('only the exact trigger body clicks; standard formatting is accepted', async () => {
  const h = harness()
  for (const text of [TRIGGER_MESSAGE.toLowerCase(), TRIGGER_MESSAGE + '!', 'quoted ' + TRIGGER_MESSAGE, TRIGGER_MESSAGE.replace('23642', '23643'), ' ' + TRIGGER_MESSAGE]) {
    await h.responder.onMessage('A', text)
  }
  await h.responder.onMessage('A', TRIGGER_MESSAGE, 2)
  await h.responder.onMessage('A', TRIGGER_MESSAGE, 'game_info')
  assert.equal(h.calls.length, 0)
  for (const text of [TRIGGER_MESSAGE, 'Main: ' + TRIGGER_MESSAGE, '<Main> ' + TRIGGER_MESSAGE, '§aMain§r: ' + TRIGGER_MESSAGE]) {
    h.advance(6000)
    await h.responder.onMessage('A', text)
  }
  assert.equal(h.calls.length, 4)
  assert.deepEqual(h.bots.A.bot.entity.position, new Vec3(0, 64, 0))
})

test('all bots hearing one message click a shared trapdoor only once', async () => {
  const h = harness(['A', 'B'])
  await Promise.all(['A', 'B'].map(id => h.responder.onMessage(id, TRIGGER_MESSAGE)))
  assert.equal(h.calls.length, 1)
  h.advance(3000)
  await h.responder.onMessage('A', TRIGGER_MESSAGE)
  assert.equal(h.calls.length, 1, 'claim outlives duplicate chat window')
  h.advance(3000)
  await h.responder.onMessage('B', TRIGGER_MESSAGE)
  assert.equal(h.calls.length, 2, 'a subsequent deliberate trigger works')
})

test('different trapdoors can be activated by separate bots', async () => {
  const h = harness(['A', 'B'])
  h.bots.B.block.position = new Vec3(2, 64, 1)
  await h.responder.onMessage('A', TRIGGER_MESSAGE)
  assert.equal(h.calls.length, 2)
})

test('no trapdoor, distant, invisible, iron and non-trapdoor blocks do nothing', async () => {
  for (const change of [
    h => { h.bots.A.bot.findBlocks = () => [] },
    h => { h.bots.A.block.position = new Vec3(10, 64, 1) },
    h => { h.bots.A.bot.canSeeBlock = () => false },
    h => { h.bots.A.block.name = 'iron_trapdoor' },
    h => { h.bots.A.block.name = 'oak_door' }
  ]) {
    const h = harness(); change(h)
    await h.responder.onMessage('A', TRIGGER_MESSAGE)
    assert.equal(h.calls.length, 0)
  }
})

test('offline, unauthenticated, configuration, sneaking and GUI bots are skipped', async () => {
  for (const change of [
    e => { e.connectionState = 'disconnected' },
    e => { e.authPending = true },
    e => { e.authenticated = false },
    e => { e.bot._client.state = 'configuration' },
    e => { e.bot._client.ended = true },
    e => { e.bot.inConfigurationPhase = true },
    e => { e.bot.controlState = { sneak: true } },
    e => { e.bot.currentWindow = {} }
  ]) {
    const h = harness(); change(h.bots.A)
    await h.responder.onMessage('A', TRIGGER_MESSAGE)
    assert.equal(h.calls.length, 0)
  }
})

test('selects nearest visible wooden trapdoor and contains failures without retries', async () => {
  const h = harness()
  const far = { name: 'birch_trapdoor', position: new Vec3(3, 64, 1) }
  h.bots.A.bot.findBlocks = () => [far.position, h.bots.A.block.position]
  h.bots.A.bot.blockAt = p => p === far.position ? far : h.bots.A.block
  await h.responder.onMessage('A', TRIGGER_MESSAGE)
  assert.equal(h.calls[0][1], h.bots.A.block)
  const f = harness()
  let attempts = 0
  f.bots.A.bot.activateBlock = async () => { attempts++; throw Error('click failed') }
  assert.deepEqual(await f.responder.onMessage('A', TRIGGER_MESSAGE), ['failed'])
  await f.responder.onMessage('A', TRIGGER_MESSAGE)
  assert.equal(attempts, 1)
  assert.match(f.logs[0][1], /click failed/)
  const s = harness()
  s.bots.A.bot.findBlocks = () => { throw Error('chunk missing') }
  await s.responder.onMessage('A', TRIGGER_MESSAGE)
  assert.match(s.logs[0][1], /chunk missing/)
})

test('actual chat event listeners are idempotent and ignore replaced connections', async () => {
  const h = harness()
  const bot = h.bots.A.bot
  h.responder.attach(bot, 'A'); h.responder.attach(bot, 'A')
  assert.equal(bot.listenerCount('messagestr'), 1)
  bot.emit('messagestr', 'Main: ' + TRIGGER_MESSAGE)
  bot.emit('chat', 'Main', TRIGGER_MESSAGE)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls.length, 1)
  h.advance(6000)
  h.bots.A = { bot: new EventEmitter() }
  bot.emit('messagestr', TRIGGER_MESSAGE)
  bot.emit('chat', 'Main', TRIGGER_MESSAGE)
  assert.equal(h.calls.length, 1)
})
