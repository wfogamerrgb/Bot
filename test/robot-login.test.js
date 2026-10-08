'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRobotLogin, admissionRoutes } = require('../robot-login')
function harness(text = 'New1\nNew2\nNew3\nNew4', options = {}) {
  let time = 0
  let pending = false
  const files = new Map([['robot.txt', text]])
  const timers = new Map()
  const attempts = [], closed = [], sent = [], logs = []
  const live = new Set(options.live || [])
  const env = { LOGIN_PASSWORD: 'one', LOGIN_PASSWORD_1: 'two', LOGIN_PASSWORD_2: 'three', ...options.env }
  const io = {
    readFileSync(file) { const n = require('path').basename(file); if (!files.has(n)) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return files.get(n) },
    writeFileSync(file, value) { files.set(require('path').basename(file), value) },
    appendFileSync(file, value) { const n = require('path').basename(file); if (options.writeFails) throw Object.assign(Error('denied'), { code: 'EACCES' }); files.set(n, (files.get(n) || '') + value) }
  }
  const manager = createRobotLogin({ io, env: () => env, now: () => time, random: () => 0.999, setTimer(fn, delay) { const t = { fn, at: time + delay, delay }; timers.set(t, t); return t }, clearTimer: t => timers.delete(t), startupPending: () => pending, roster: () => options.roster || [], existing: () => [...live], blocked: name => name === 'Banned', connect(name) { attempts.push({ name, time, route: manager.route(name) }); live.add(name); return true }, close(name) { closed.push(name); live.delete(name) }, send(name, cmd) { sent.push([name, cmd, time]) }, log: text => logs.push(text), isPlayerChat: text => text.startsWith('Player:') })
  function advance(ms) { const end = time + ms; for (;;) { const next = [...timers.values()].filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0]; if (!next) break; timers.delete(next); time = next.at; next.fn() } time = end }
  return { manager, files, attempts, closed, sent, logs, env, advance, setPending: p => { pending = p }, live }
}
test('ignores pending startup attempts, skips case-insensitive ghosts and blocked names without cooldown or route slots', () => {
  const h = harness('Old\nold\nLive\nBanned\nBad-name\nRemoved\nNew1\nNEW1\nNew2\nNew3\nNew4', { roster: ['OLD'], live: ['LIVE'], env: { PROXY_GROUP_1_HOST: 'p1', PROXY_GROUP_3_HOST: 'p3' } })
  h.files.set('removed.txt', 'Removed # wrong login\n')
  h.setPending(true)
  assert.equal(h.manager.start().ok, true)
  assert.equal(h.attempts.length, 1, 'a pending .env queue must not hold admissions')
  h.advance(15000)
  assert.deepEqual(h.attempts.map(a => a.time), [0, 5000, 10000, 15000])
  assert.deepEqual(h.attempts.map(a => a.route?.index ?? null), [null, 1, 3, null])
  assert.deepEqual(h.attempts.map(a => a.name.toLowerCase()), ['new1', 'new2', 'new3', 'new4'])
})
test('routes ignore invalid proxies and include valid empty-list/gapped groups', () => {
  assert.deepEqual(admissionRoutes({ PROXY_GROUP_1_HOST: 'x', PROXY_GROUP_1_PORT: 'bad', PROXY_GROUP_2_HOST: 'x', PROXY_GROUP_2_TYPE: 'ssh', PROXY_GROUP_8_HOST: 'proxy', PROXY_GROUP_8_BOTS: '' }).map(r => r?.index ?? null), [null, 8])
})
test('password candidates advance only after rejection, wait 1.5 seconds and stop on success', () => {
  const h = harness('New1')
  h.manager.start()
  h.manager.onMessage('New1', 'Please /login password')
  h.manager.onMessage('New1', 'Please /login password')
  h.advance(250)
  assert.deepEqual(h.sent.map(a => a[1]), ['/login one'])
  h.manager.onMessage('New1', 'Player: wrong password')
  h.manager.onMessage('New1', 'Wrong password!')
  h.manager.onMessage('New1', 'Please /login password')
  h.advance(1499)
  assert.equal(h.sent.length, 1)
  h.advance(1)
  assert.equal(h.sent[1][1], '/login two')
  h.manager.onMessage('New1', 'Wrong password')
  h.advance(1500)
  assert.equal(h.sent[2][1], '/login three')
  h.manager.onMessage('New1', 'Successfully logged in!')
  h.manager.setupReady('New1')
  assert.equal(h.manager.state('New1').phase, 'admitted')
  h.advance(180000)
  assert.equal(h.closed.length, 0)
  assert.equal(h.manager.fail('New1', 'later error'), false, 'normal reconnect resumes after setup')
})
test('success during fallback wait cancels pending password and waits for setup', () => {
  const h = harness('New1')
  h.manager.start(); h.manager.onMessage('New1', 'Please /login password'); h.advance(250)
  h.manager.onMessage('New1', 'Wrong password'); h.manager.onMessage('New1', 'Login successful')
  h.advance(1500)
  assert.equal(h.sent.length, 1)
  assert.equal(h.manager.isAdmitting('New1'), true)
  h.manager.setupReady('New1')
  assert.equal(h.manager.isAdmitting('New1'), false)
})
test('throttling during the fallback delay cancels the queued candidate immediately', () => {
  const h = harness('New1'); h.manager.start(); h.manager.onMessage('New1', 'Please /login password'); h.advance(250)
  h.manager.onMessage('New1', 'Wrong password')
  h.manager.onMessage('New1', 'Too many attempts; try again later')
  h.advance(1500)
  assert.equal(h.sent.length, 1)
  assert.deepEqual(h.closed, ['New1'])
})

test('exhaustion, throttling, duplicate rejection and timeouts close and persist one blocked record', () => {
  for (const reason of ['Wrong password', 'Too many failed attempts', 'Already connected', 'timeout']) {
    const h = harness('New1', { env: { LOGIN_PASSWORD_1: 'one', LOGIN_PASSWORD_2: 'one' } })
    h.manager.start()
    if (reason === 'timeout') h.advance(180000)
    else { h.manager.onMessage('New1', 'Please /login password'); h.advance(250); h.manager.onMessage('New1', reason) }
    assert.deepEqual(h.closed, ['New1'], reason)
    assert.match(h.files.get('removed.txt'), /^New1\t# /)
    h.manager.start(); assert.equal(h.attempts.length, 1)
    assert.equal(h.manager.start({ retry: 'New1' }).ok, true)
    h.advance(5000)
    assert.equal(h.attempts.length, 2)
  }
})
test('hand removal restores blocked name, but failed persistence remains fail-closed', () => {
  const h = harness('New1'); h.manager.start(); h.manager.fail('New1', 'oops one')
  assert.doesNotMatch(h.files.get('removed.txt'), /oops one/)
  h.files.set('removed.txt', '')
  h.manager.start(); h.advance(5000)
  assert.equal(h.attempts.length, 2)
  const denied = harness('New1', { writeFails: true }); denied.manager.start(); denied.manager.fail('New1', 'oops')
  denied.manager.start(); denied.advance(5000)
  assert.equal(denied.attempts.length, 1)
})
test('changed credentials/routes are read for later admissions; stopping cancels queue only', () => {
  const h = harness('New1\nNew2', { env: { PROXY_GROUP_1_HOST: 'old' } })
  h.manager.start(); h.env.PROXY_GROUP_1_HOST = 'fresh'; h.env.LOGIN_PASSWORD = 'newpassword'; h.advance(5000)
  assert.equal(h.attempts[1].route.host, 'fresh')
  assert.equal(h.manager.state('New2').passwords[0], 'newpassword')
  const stopped = harness(); stopped.manager.start(); stopped.manager.stop(); stopped.advance(5000)
  assert.equal(stopped.attempts.length, 1)
  assert.equal(stopped.manager.isAdmitting('New1'), true)
})
