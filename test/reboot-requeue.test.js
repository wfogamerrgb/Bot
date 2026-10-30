'use strict'
// Tests for reboot-requeue.js — fake clock, no network.
// Run: node --test test/reboot-requeue.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRebootRequeue } = require('../reboot-requeue')

const REBOOT_CHAT = [
  '⚠ Server Reboot',
  'The server will be rebooting soon',
  'you will be returned automatically',
  '↓ Reboot Time ↓',
  '♦ Happening In: 1s',
]

function makeHarness (opts) {
  opts = opts || {}
  const sent = []
  const logs = []
  const timers = []
  let clock = 1000000
  let seq = 0
  const env = { SERVER_COMMAND: '/server lifesteal', ...(opts.env || {}) }

  const q = createRebootRequeue({
    sendChat: (id, msg) => { sent.push({ id, msg }); return true },
    log: (id, msg) => logs.push({ id, msg }),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { id: ++seq, fn, at: clock + Math.max(0, ms) }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t)
      if (i >= 0) timers.splice(i, 1)
    },
    getEnv: () => env,
  })

  function advance (ms) {
    const target = clock + ms
    // fire due timers in time order, like a real event loop
    for (;;) {
      const due = timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      clock = due.at
      const i = timers.indexOf(due)
      if (i >= 0) timers.splice(i, 1)
      due.fn()
    }
    clock = target
  }

  return { q, sent, logs, advance, env, get now () { return clock } }
}

test('inert until a reboot is announced: a plain reconnect sends nothing', () => {
  const h = makeHarness()
  h.q.onState('A', 'configuration')
  h.q.onState('A', 'play')
  h.advance(60000)
  assert.deepEqual(h.sent, [])
  assert.equal(h.q.status('A').phase, 'idle')
})

test('announcement → wait for play → 10s settle → one /server lifesteal', () => {
  const h = makeHarness()
  for (const line of REBOOT_CHAT) h.q.onChat('A', line)
  h.advance(1000)                       // "Happening In: 1s" elapses; server drops
  h.q.onState('A', 'configuration')     // restart handshake
  h.advance(8000)
  assert.equal(h.sent.length, 0, 'must not send while the server is down')

  h.q.onState('A', 'play')              // back online
  h.advance(9999)
  assert.equal(h.sent.length, 0, 'nothing before the 10s settle')
  h.advance(1)
  assert.deepEqual(h.sent, [{ id: 'A', msg: '/server lifesteal' }])
  assert.equal(h.q.status('A').phase, 'requested')
})

test('the settle countdown starts at play, not at the announcement', () => {
  const h = makeHarness()
  h.q.onChat('A', 'The server will be rebooting soon')
  h.advance(20000)                      // long restart
  h.q.onState('A', 'play')
  h.advance(9000)
  assert.equal(h.sent.length, 0)
  h.advance(1000)
  assert.equal(h.sent.length, 1)
})

test('repeated "Happening In:" lines do not restart anything', () => {
  const h = makeHarness()
  h.q.onChat('A', '⚠ Server Reboot')
  h.advance(500)
  h.q.onChat('A', '♦ Happening In: 1s')
  h.q.onChat('A', '♦ Happening In: 1s')
  h.q.onState('A', 'play')
  h.advance(10000)
  assert.equal(h.sent.length, 1)
  assert.match(h.logs.filter(l => /server reboot announced/.test(l.msg)).length.toString(), /^1$/)
})

test('"Please wait" retries after REBOOT_REQUEUE_RETRY_MS, then succeeds on the handshake', () => {
  const h = makeHarness()
  h.q.onChat('A', '⚠ Server Reboot')
  h.q.onState('A', 'play')
  h.advance(10000)
  assert.equal(h.sent.length, 1)

  h.q.onChat('A', 'Please wait 30 seconds before trying again')
  h.advance(4999)
  assert.equal(h.sent.length, 1, 'no retry before the retry delay')
  h.advance(1)
  assert.equal(h.sent.length, 2, 'retried once')

  h.q.onState('A', 'configuration')     // transfer handshake = success
  assert.equal(h.q.status('A').phase, 'done')
  h.advance(60000)
  assert.equal(h.sent.length, 2, 'nothing more after success')
  assert.ok(h.logs.some(l => /accepted — server sent the configuration handshake/.test(l.msg)))
})

test('no reply at all still retries (safety net), and stops at MaxAttempts', () => {
  const h = makeHarness({ env: { REBOOT_REQUEUE_MAX_ATTEMPTS: '3', REBOOT_REQUEUE_RETRY_MS: '1000' } })
  h.q.onChat('A', 'Server Reboot')
  h.q.onState('A', 'play')
  h.advance(10000)                      // attempt 1
  h.advance(1000)                       // attempt 2
  h.advance(1000)                       // attempt 3
  assert.equal(h.sent.length, 3)
  h.advance(10000)
  assert.equal(h.sent.length, 3, 'must not exceed MaxAttempts')
  assert.equal(h.q.status('A').phase, 'done')
  assert.ok(h.logs.some(l => /gave up after 3 attempt/.test(l.msg)))
})

test('a "configuration" state before the command is sent keeps waiting (not success)', () => {
  const h = makeHarness()
  h.q.onChat('A', '⚠ Server Reboot')
  h.q.onState('A', 'configuration')     // proxy bouncing us during the restart
  h.advance(10000)
  assert.equal(h.sent.length, 0, 'still waiting for play')
  h.q.onState('A', 'play')
  h.advance(10000)
  assert.equal(h.sent.length, 1)
})

test('env overrides: delay, retry gap and command', () => {
  const h = makeHarness({ env: { REBOOT_REQUEUE_DELAY_MS: '1500', REBOOT_REQUEUE_RETRY_MS: '250', REBOOT_REQUEUE_COMMAND: '/server survival' } })
  h.q.onChat('A', '⚠ Server Reboot')
  h.q.onState('A', 'play')
  h.advance(1500)
  assert.deepEqual(h.sent, [{ id: 'A', msg: '/server survival' }])
  h.q.onChat('A', 'try again later')
  h.advance(250)
  assert.equal(h.sent.length, 2)
})

test('disabled by env: never sends, never arms', () => {
  const h = makeHarness({ env: { REBOOT_REQUEUE_ENABLED: '0' } })
  h.q.onChat('A', '⚠ Server Reboot')
  h.q.onState('A', 'play')
  h.advance(60000)
  assert.deepEqual(h.sent, [])
  assert.equal(h.q.isArmed('A'), false)
})

test('suppressesStartup is true only inside an armed window', () => {
  const h = makeHarness()
  assert.equal(h.q.suppressesStartup('A'), false)
  h.q.onChat('A', '⚠ Server Reboot')
  assert.equal(h.q.suppressesStartup('A'), true)
  h.q.onState('A', 'play')
  h.advance(10000)
  assert.equal(h.q.suppressesStartup('A'), true, 'still armed while waiting for the handshake')
  h.q.onState('A', 'configuration')
  assert.equal(h.q.suppressesStartup('A'), false)
})

test('TTL: a reboot announced but never happening stands down without sending', () => {
  const h = makeHarness({ env: { REBOOT_REQUEUE_TTL_MS: '5000' } })
  h.q.onChat('A', '⚠ Server Reboot')
  h.advance(5000)
  assert.equal(h.q.status('A').phase, 'done')
  assert.equal(h.sent.length, 0)
  assert.ok(h.logs.some(l => /standing down/.test(l.msg)))
})

test('two bots are tracked independently', () => {
  const h = makeHarness()
  h.q.onChat('A', '⚠ Server Reboot')
  h.q.onState('A', 'play')
  h.advance(10000)
  assert.deepEqual(h.sent, [{ id: 'A', msg: '/server lifesteal' }])

  // B was never armed, so its own state transitions must not send anything.
  // (A keeps retrying in the background here — that is its safety net — so
  // assert per-bot rather than on the total.)
  h.q.onState('B', 'play')
  h.q.onState('B', 'configuration')
  h.advance(10000)
  assert.equal(h.sent.filter(m => m.id === 'B').length, 0, 'B was never armed')
  assert.ok(h.sent.some(m => m.id === 'A'), 'A keeps its own retry schedule')
})
