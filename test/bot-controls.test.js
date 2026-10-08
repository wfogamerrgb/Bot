'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readDelayMs, readInt, readNumber, parseDumpMode, parseDataArgs, parseCratesAllDump, parseCratesAllAfk, parseCratesAllFlags, shuffledCopy, createSlowBroadcast, createSlowBroadcastManager, parseChatGameRange, parseChatGameEquation, isChatGameEnd, createChatGameManager, parseProxyGroups, resolveBotProxy, hasProxyAuth, proxyAuthHeader, buildHttpConnectRequest, describeProxy, resolveLoginPassword, resolveFallbackPassword, parseBotPasswords, classifyAuthReply, nextAuthFailure, isAuthBlocked, findIgnoredProxyGroupVars, destructiveCommandEffect, createCommandConfirmation, parseItemGlobs, itemMatchesGlobs, parseRewardSlots, parseScript, parseScriptLine, selectScriptBots, listBotScripts, loadBotScript, parseTorControlPorts, deriveTorControlPorts, deriveTorControlTargets, resolveTorScope, sendTorSignal, commandSuggestions } = require('../bot-controls')

function clock() {
  let time = 0, sequence = 0
  const timers = new Map()
  return {
    timers,
    get time() { return time },
    setTimer(fn, delay) { const id = ++sequence; timers.set(id, { fn, due: time + delay }); return id },
    clearTimer(id) { timers.delete(id) },
    tick(ms) {
      const end = time + ms
      while (true) {
        const due = [...timers].sort((a, b) => a[1].due - b[1].due)[0]
        if (!due || due[1].due > end) break
        time = due[1].due; timers.delete(due[0]); due[1].fn()
      }
      time = end
    }
  }
}

test('duration settings and crate scheduling accept strict units and reject timer overflow', () => {
  assert.equal(readDelayMs('1.5s'), 1500)
  assert.equal(readDelayMs('2m'), 120000)
  assert.equal(readDelayMs('2s-junk', 100), 100)
  for (const [value, expected] of [['0', 0], ['30', 30000], ['30s', 30000], ['1.5s', 1500], ['250ms', 250], ['2min', 120000], ['1h', 3600000]]) {
    assert.equal(parseCratesAllFlags([`delay=${value}`]).delayMs, expected)
  }
  for (const value of ['-1', '30junk', 'Infinity', '2147483648ms', '1.5ms']) assert.deepEqual(parseCratesAllFlags([`delay=${value}`]).unknown, [`delay=${value}`])
})

test('readInt and readNumber fall back on missing, junk, or out-of-range values', () => {
  assert.equal(readInt(undefined, 50), 50)
  assert.equal(readInt('', 50), 50)
  assert.equal(readInt('500', 50), 500)
  assert.equal(readInt('0', 50, 1, 500), 50)
  assert.equal(readInt('501', 50, 1, 500), 50)
  assert.equal(readInt('12.4', 50), 12)
  assert.equal(readInt('junk', 50), 50)
  assert.equal(readNumber('30', 30, 1, 256), 30)
  assert.equal(readNumber('3.5', 10, 0.5, 1000), 3.5)
  assert.equal(readNumber('0.1', 10, 0.5, 1000), 10)
  assert.equal(readNumber('nope', 10, 0.5, 1000), 10)
})

test('parseDumpMode flags a typo instead of silently starting a TPA dump', () => {
  assert.deepEqual(parseDumpMode(undefined), { mode: 'tpa', unknown: null })
  assert.deepEqual(parseDumpMode(''), { mode: 'tpa', unknown: null })
  assert.deepEqual(parseDumpMode('HOME'), { mode: 'home', unknown: null })
  assert.deepEqual(parseDumpMode('hidden'), { mode: 'hidden', unknown: null })
  assert.deepEqual(parseDumpMode('cancel'), { mode: 'cancel', unknown: null })
  assert.deepEqual(parseDumpMode('hiden'), { mode: 'tpa', unknown: 'hiden' })
})

test('destructiveCommandEffect names the fleet-killers and nothing else', () => {
  assert.equal(destructiveCommandEffect('/exit'), 'kills the bot process and disconnects every bot')
  for (const cmd of ['/all /dc', '/all-slow /dc', '/all-slow 30 /dc', '/all-slow 500ms /disconnect', '/all /dc now']) {
    assert.equal(destructiveCommandEffect(cmd), 'disconnects every bot at once', cmd)
  }
  for (const cmd of ['/dc', '/status', '/all /status', '/all !hello', '/exitish', '/alliance', '', undefined]) {
    assert.equal(destructiveCommandEffect(cmd), null, String(cmd))
  }
})

test('createCommandConfirmation runs only on an exact repeat inside the window', () => {
  let now = 0
  const confirm = createCommandConfirmation(60000, () => now)
  assert.equal(confirm.confirm('/exit'), false, 'first run warns')
  assert.equal(confirm.confirm('/all /dc'), false, 'a different command warns too')
  assert.equal(confirm.confirm('/exit'), true, 'the exact repeat confirms')
  assert.equal(confirm.confirm('/exit'), false, 'a confirmation is one-shot')
  now = 120000
  assert.equal(confirm.confirm('/exit'), false, 'an expired window warns again')
})

test('crates-all dump= picks the dump step, and a bare value is a TPA target', () => {
  assert.equal(parseCratesAllDump(undefined).dump, 'tpa')
  assert.equal(parseCratesAllDump('').dump, 'tpa')
  assert.equal(parseCratesAllDump('OFF').dump, 'off')
  assert.equal(parseCratesAllDump('none').dump, 'off')
  assert.equal(parseCratesAllDump('HOME').dump, 'home')
  assert.equal(parseCratesAllDump('hidden').dump, 'hidden')
  // A target must be spelled out: `dump=Smith` is a typo, not a player name, so
  // it is reported instead of teleporting the bot to a player called "Smith".
  assert.deepEqual(parseCratesAllDump('player:Smith'), { dump: 'tpa', target: 'Smith', unknown: null })
  assert.deepEqual(parseCratesAllDump('Smith'), { dump: 'tpa', target: null, unknown: 'Smith' })
  assert.deepEqual(parseCratesAllDump('hmeo'), { dump: 'tpa', target: null, unknown: 'hmeo' })
  assert.equal(parseCratesAllDump('player:Jt_2').target, 'Jt_2')
  // A target that is missing entirely is reported, not run against an empty name.
  assert.equal(parseCratesAllDump('player:').unknown, 'player:')
})

test('crates-all afk= understands now/off/seconds and rejects the rest', () => {
  assert.deepEqual(parseCratesAllAfk('now'), { warp: true, delayMs: 0, unknown: null })
  assert.deepEqual(parseCratesAllAfk('0'), { warp: true, delayMs: 0, unknown: null })
  assert.deepEqual(parseCratesAllAfk('off'), { warp: false, delayMs: null, unknown: null })
  assert.deepEqual(parseCratesAllAfk('false'), { warp: false, delayMs: null, unknown: null })
  assert.equal(parseCratesAllAfk('30').delayMs, 30000) // a bare number means seconds
  assert.equal(parseCratesAllAfk('90s').delayMs, 90000)
  assert.equal(parseCratesAllAfk('1500ms').delayMs, 1500)
  assert.equal(parseCratesAllAfk('-5').unknown, '-5')
  assert.equal(parseCratesAllAfk('soon').unknown, 'soon')
  // Larger than a setTimeout can hold: rejected rather than clamped to 1ms.
  assert.equal(parseCratesAllAfk('999999999999').unknown, '999999999999')
})

test('crates-all flags leave unset options null and report unreadable tokens', () => {
  // Null means "not specified here" so the caller can fall back to .env.
  assert.deepEqual(parseCratesAllFlags([]), { dump: null, dumpTarget: null, afkWarp: null, afkDelayMs: null, unknown: [] })
  assert.deepEqual(parseCratesAllFlags(['dump=off', 'afk=now']), { dump: 'off', dumpTarget: null, afkWarp: true, afkDelayMs: 0, unknown: [] })
  assert.deepEqual(parseCratesAllFlags(['DUMP=player:Smith', 'AFK=30000ms']), { dump: 'tpa', dumpTarget: 'Smith', afkWarp: true, afkDelayMs: 30000, unknown: [] })
  // A typo must be reported, never silently treated as a player name or a delay.
  assert.deepEqual(parseCratesAllFlags(['dump=', 'afk=', 'foo=1', 'dump', '=off']).unknown, ['dump=', 'afk=', 'foo=1', 'dump', '=off'])
  // A bare player name is a typo, never a silent teleport target.
  assert.deepEqual(parseCratesAllFlags(['dump=Smith']).unknown, ['dump=Smith'])
})

test('delay defaults and validation never let Node clamp invalid values to 1ms', () => {
  for (const value of [undefined, '', ' ', 'NaN', 'Infinity', '-1', '0', '1.5', '15000junk', '2147483648']) assert.equal(readDelayMs(value), 15000)
  assert.equal(readDelayMs('2000'), 2000)
  assert.equal(readDelayMs(' 15000 '), 15000)
  assert.equal(readDelayMs('2147483647'), 2147483647)
})

test('Fisher-Yates shuffles a copy and preserves each input', () => {
  const input = ['A', 'B', 'C', 'D']
  const output = shuffledCopy(input, () => 0)
  assert.deepEqual(output, ['B', 'C', 'D', 'A'])
  assert.deepEqual(input, ['A', 'B', 'C', 'D'])
  assert.deepEqual([...output].sort(), input)
  assert.deepEqual(shuffledCopy([]), [])
  assert.deepEqual(shuffledCopy(['A']), ['A'])
})

test('slow broadcast starts immediately, spaces dispatches, and uses one timer', () => {
  const c = clock(), calls = [], done = []
  const job = createSlowBroadcast(c)
  job.start(['A', 'B', 'C'], 15000, id => { calls.push([id, c.time]); return true }, { onDone: r => done.push(r) })
  assert.deepEqual(calls, [['A', 0]])
  assert.equal(c.timers.size, 1)
  assert.equal(job.start(['D'], 15000, () => true), false)
  c.tick(14999); assert.equal(calls.length, 1)
  c.tick(1); assert.deepEqual(calls[1], ['B', 15000])
  assert.equal(c.timers.size, 1)
  c.tick(15000); assert.deepEqual(calls[2], ['C', 30000])
  assert.equal(c.timers.size, 0)
  assert.equal(job.running, false)
  assert.deepEqual(done, [{ sent: 3, skipped: 0 }])
})

test('custom delay, skips, failures, snapshot isolation and cancellation', () => {
  const c = clock(), ids = ['A', 'B', 'C', 'D'], seen = [], errors = [], done = []
  const job = createSlowBroadcast(c)
  job.start(ids, 25, id => {
    seen.push(id)
    if (id === 'B') return false
    if (id === 'C') throw Error('offline')
    return true
  }, { onError: (err, id) => errors.push(id), onDone: r => done.push(r) })
  ids.push('E'); c.tick(75)
  assert.deepEqual(seen, ['A', 'B', 'C', 'D'])
  assert.deepEqual(errors, ['C'])
  assert.deepEqual(done, [{ sent: 2, skipped: 2 }])
  job.start(['E', 'F'], 25, id => { seen.push(id); return true })
  job.cancel(); c.tick(100)
  assert.equal(seen.at(-1), 'E')
  assert.equal(job.running, false)
  assert.equal(c.timers.size, 0)
})

test('empty broadcast finishes without a timer', () => {
  const c = clock(), job = createSlowBroadcast(c)
  let result
  job.start([], 15000, () => assert.fail(), { onDone: r => { result = r } })
  assert.deepEqual(result, { sent: 0, skipped: 0 })
  assert.equal(job.running, false)
  assert.equal(c.timers.size, 0)
})

// ── Tor control (fresh circuits) ───────────────────────────────────────────

test('parseTorControlPorts reads a messy list and deriveTorControlPorts keeps local instances only', () => {
  assert.deepEqual(parseTorControlPorts('9051,9151 9251;9051'), [9051, 9151, 9251])
  assert.deepEqual(parseTorControlPorts(''), [])
  assert.deepEqual(parseTorControlPorts('0,70000,abc,-1, 9051'), [9051], 'junk and out-of-range entries are dropped')
  assert.deepEqual(parseTorControlPorts(null), [])
  // The convention is scripts/restart-tor.sh's: control port = SOCKS + 1.
  assert.deepEqual(deriveTorControlPorts(
    [{ host: '127.0.0.1', port: 9150 }, { host: 'localhost', port: 9250 }, { host: 'proxy.example.com', port: 1080 }],
    { host: '127.0.0.1', port: 9050 }
  ), [9151, 9251, 9051])
  assert.deepEqual(deriveTorControlPorts([{ host: '10.0.0.5', port: 9050 }], null), [], 'a remote proxy is nobody we can signal')
  assert.deepEqual(deriveTorControlPorts([{ host: '127.0.0.1', port: 9050 }, { host: 'localhost', port: 9050 }], null, 2), [9052], 'the same instance is listed once')
  assert.deepEqual(deriveTorControlPorts([], { host: 'localhost', port: 65535 }), [], 'offsetting past 65535 is not a port')
})

test('deriveTorControlTargets keeps routing keys and resolveTorScope scopes a rotation', () => {
  const groups = [
    { index: 1, bots: ['a', 'b'], host: '', port: 9150 },
    { index: 2, bots: ['c'], host: 'localhost', port: 9050 },
    { index: 3, bots: ['d'], host: '10.0.0.9', port: 9250 }
  ]
  const def = { host: '127.0.0.1', port: 9150 }
  assert.deepEqual(deriveTorControlTargets(groups, def), [
    { port: 9151, keys: [1, 'default'] },
    { port: 9051, keys: [2] }
  ], 'a host-less group rides the default instance; a remote group is nobody we can signal')
  assert.deepEqual(deriveTorControlTargets([], null), [], 'no proxies, no control ports')
  assert.deepEqual(deriveTorControlTargets([{ index: 1, bots: ['a'], host: 'localhost', port: 65535 }], null), [], 'offsetting past 65535 is not a port')

  const ids = ['a', 'b', 'c', 'd', 'e']
  assert.deepEqual(resolveTorScope('', groups, ids).botIds, ids, 'no argument means everything')
  assert.equal(resolveTorScope('all', groups, ids).scope, 'all')
  assert.deepEqual(resolveTorScope('2', groups, ids), { ok: true, scope: 2, label: 'proxy group 2', botIds: ['c'] })
  assert.deepEqual(resolveTorScope('default', groups, ids), { ok: true, scope: 'default', label: 'ungrouped bots', botIds: ['e'] })
  assert.deepEqual(resolveTorScope('c', groups, ids), { ok: true, scope: 2, label: 'proxy group 2 (c)', botIds: ['c'] }, 'a bot name resolves to its group')
  assert.deepEqual(resolveTorScope('e', groups, ids), { ok: true, scope: 'default', label: 'ungrouped bots (e)', botIds: ['e'] })
  const bad = resolveTorScope('9', groups, ids)
  assert.equal(bad.ok, false)
  assert.match(bad.error, /configured groups: 1, 2, 3/)
  assert.equal(resolveTorScope('zzz', groups, ids).ok, false, 'an unknown name is an error, never a rotate-everything fallback')
})

test('sendTorSignal authenticates and signals, and a dead or rude port is a result not a throw', async () => {
  const net = require('node:net')
  const listen = handler => new Promise(resolve => {
    const server = net.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
  const close = server => new Promise(resolve => server.close(resolve))
  const withServer = async (handler, fn) => {
    const server = await listen(handler)
    try { return await fn(server.address().port) } finally { await close(server) }
  }

  // The real conversation: AUTHENTICATE + SIGNAL + QUIT go out together, and
  // both 250 answers come back before the connection closes.
  await withServer(sock => sock.on('data', () => { sock.write('250 OK\r\n250 OK\r\n'); sock.end() }), async port => {
    const result = await sendTorSignal(port)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.port, port)
    assert.match(result.reply, /250/)
  })

  await withServer(sock => sock.on('data', () => { sock.write('515 Authentication failed\r\n'); sock.end() }), async port => {
    const result = await sendTorSignal(port)
    assert.equal(result.ok, false, 'a refused AUTHENTICATE is a failure')
    assert.match(result.error, /515/)
  })

  // The fake control port reads but never answers. It must consume the socket
  // data — an ignored (paused) socket never sees the client's FIN, and the
  // server would linger forever.
  await withServer(sock => sock.on('data', () => {}), async port => {
    const result = await sendTorSignal(port, { timeoutMs: 50 })
    assert.equal(result.ok, false, 'a silent port times out instead of hanging')
    assert.match(result.error, /no reply/)
  })

  // Nothing is listening: ECONNREFUSED comes back as a result too.
  const spare = await listen(_sock => {})
  const deadPort = spare.address().port
  await close(spare)
  const refused = await sendTorSignal(deadPort)
  assert.equal(refused.ok, false)
  assert.ok(refused.error, 'the failure says why')
})

// ── Chat games (guess the number) ──────────────────────────────────────────

test('parseChatGameRange reads hint lines and never reads a countdown as a range', () => {
  assert.deepEqual(parseChatGameRange('Hint: 1-15 | Reward: $2,500'), { min: 1, max: 15 })
  assert.deepEqual(parseChatGameRange('\u2726 Hint: 1 \u2013 15 | Reward: $2,500'), { min: 1, max: 15 })
  assert.deepEqual(parseChatGameRange('Guess a number between 3 and 9'), { min: 3, max: 9 })
  assert.deepEqual(parseChatGameRange('Guess the number: 1-15'), { min: 1, max: 15 })
  assert.deepEqual(parseChatGameRange('Hint: 15-1'), { min: 1, max: 15 }, 'a reversed range is normalized')
  assert.equal(parseChatGameRange('A chat event has started! You have 20 seconds to guess the number'), null, 'a countdown is not a range')
  assert.equal(parseChatGameRange('Reward: $2,500'), null, 'a price is not a range')
  assert.equal(parseChatGameRange(''), null)
  assert.equal(parseChatGameRange(null), null)
})

test('isChatGameEnd ends a round on a reveal or wrap-up but never on the prompt', () => {
  for (const line of ['The correct number was 7!', 'Steve guessed the number!', 'The chat event has ended', 'Nobody guessed the number in time']) {
    assert.equal(isChatGameEnd(line), true, line)
  }
  for (const line of ['A chat event has started! You have 20 seconds to guess the number', 'Hint: 1-15 | Reward: $2,500', 'Hypr7_C0re won a coinflip for $50,000']) {
    assert.equal(isChatGameEnd(line), false, line)
  }
})

test('the chat game manager covers the range once, in random order, from random pool bots', () => {
  const c = clock()
  const guesses = []
  // Fixed-seed LCG: deterministic enough to assert on, random enough that the
  // order is not the sorted one.
  let seed = 12345
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const job = createChatGameManager({ ...c, random, submit: (id, n) => { guesses.push([id, n]); return true } })
  job.feed('A chat event has started! You have 20 seconds to guess the number', { bots: ['A', 'B', 'C', 'D', 'E'], intervalMs: 100, maxBots: 3 })
  assert.equal(job.running, false, 'a countdown alone starts nothing')
  assert.equal(guesses.length, 0)
  job.feed('Hint: 1-5 | Reward: $2,500', { bots: ['A', 'B', 'C', 'D', 'E'], intervalMs: 100, maxBots: 3 })
  assert.equal(job.running, true)
  assert.equal(guesses.length, 1, 'the first guess fires immediately — the round clock is ticking')
  c.tick(1000)
  const values = guesses.map(([, n]) => n)
  assert.deepEqual([...values].sort((a, b) => a - b), [1, 2, 3, 4, 5], 'every number in range exactly once')
  assert.notDeepEqual(values, [1, 2, 3, 4, 5], 'in random order, not 1, 2, 3, 4, 5')
  const senders = new Set(guesses.map(([id]) => id))
  assert.equal(senders.size > 1, true, 'more than one bot sends guesses')
  assert.deepEqual([...senders].sort(), [...senders].filter(id => ['A', 'B', 'C'].includes(id)).sort(), 'only the first maxBots connected bots are used')
  assert.equal(job.running, false, 'the round ends when the range is covered')
  assert.equal(c.timers.size, 0, 'and no timer is left behind')
})

test('a reveal stops the chat game cold, and a new prompt starts a fresh round', () => {
  const c = clock(), guesses = []
  const job = createChatGameManager({ ...c, submit: (id, n) => { guesses.push(n); return true } })
  job.feed('Hint: 1-100', { bots: ['A'], intervalMs: 100 })
  assert.equal(job.running, true)
  job.feed('The correct number was 37!')
  assert.equal(job.running, false, 'the reveal ends the round')
  const sent = guesses.length
  c.tick(10000)
  assert.equal(guesses.length, sent, 'nothing is sent after the reveal')
  job.feed('Hint: 3-4', { bots: ['A'], intervalMs: 100 })
  assert.equal(job.running, true, 'a new prompt starts a new round')
  c.tick(1000)
  assert.deepEqual([...guesses.slice(sent)].sort((a, b) => a - b), [3, 4], 'with its own range')
  assert.equal(job.running, false)
})

test('a chat game pool that cannot speak ends the round instead of spinning', () => {
  const c = clock()
  const job = createChatGameManager({ ...c, submit: () => false })
  job.feed('Hint: 1-5', { bots: ['A', 'B'], intervalMs: 100 })
  c.tick(10000)
  assert.equal(job.running, false, 'every sender dead → the round gives up')
  assert.equal(c.timers.size, 0)
})

// ── Chat games (equation rounds) ────────────────────────────────────────────

test('parseChatGameEquation computes the exact value of the variable, never guesses', () => {
  assert.deepEqual(parseChatGameEquation('Solve: 3x+5=20'), { equation: '3x+5=20', variable: 'x', answer: 5, answerText: '5' })
  assert.equal(parseChatGameEquation('\u2726 Solve: 3x+5=20 | Reward: $2,500').answerText, '5', 'the round banner is a prompt')
  assert.equal(parseChatGameEquation('Solve for x: 2x-4=10').answerText, '7')
  assert.equal(parseChatGameEquation('Quick math! 3(x+2)=15 | Reward: $1,000').answerText, '3', 'a factored side is distributed exactly')
  assert.equal(parseChatGameEquation('What is x? 5x=25').answerText, '5')
  assert.equal(parseChatGameEquation('Solve: x/2=4').answerText, '8')
  assert.equal(parseChatGameEquation('Solve: 0.5x=3').answerText, '6', 'decimals are rationals, not guesses')
  assert.equal(parseChatGameEquation('Solve: 2x+1=x+4').answerText, '3', 'variables on both sides')
  assert.equal(parseChatGameEquation('Solve: 2x=7').answerText, '3.5', 'a non-integer answer is exact')
  assert.equal(parseChatGameEquation('Solve: 2x+10=4').answerText, '-3', 'negative answers carry their sign')
  assert.equal(parseChatGameEquation('Solve: 3x+5=20 (x=?)').answerText, '5', 'a "what is x" tag is not a second equation')
  assert.equal(parseChatGameEquation('Solve: 3x+5=3x+9'), null, 'no unique solution — nothing is sent')
  assert.equal(parseChatGameEquation('Solve: x=x'), null, 'an identity has no answer to compute')
  assert.equal(parseChatGameEquation('Solve: x+y=5'), null, 'two variables — nothing is sent')
  assert.equal(parseChatGameEquation('Solve: x^2=9'), null, 'non-linear is never guessed at')
  assert.equal(parseChatGameEquation('Solve: 3x+5=?'), null, 'a blank is not an equation')
  assert.equal(parseChatGameEquation('I think x = 5 lol'), null, 'player chatter is not a prompt')
  assert.equal(parseChatGameEquation('Score = 5 | Reward: $100'), null, 'a scoreboard line is not an equation')
  assert.equal(parseChatGameEquation('1+1=2'), null, 'nothing to solve')
  assert.equal(parseChatGameEquation(''), null)
  assert.equal(parseChatGameEquation(null), null)
})

test('isChatGameEnd also wraps up equation rounds before a reveal can be answered', () => {
  for (const line of ['Nobody solved the equation in time', 'The correct answer was 5!', 'Steve solved the equation!', 'The answer was 5']) {
    assert.equal(isChatGameEnd(line), true, line)
  }
})

test('an equation round is answered exactly once, by one bot, with the computed answer', () => {
  const c = clock(), sent = []
  const job = createChatGameManager({ ...c, now: () => c.time, submit: (id, v) => { sent.push([id, v]); return true } })
  job.feed('Solve: 3x+5=20 | Reward: $2,500', { bots: ['A', 'B', 'C', 'D'], maxBots: 3 })
  assert.equal(sent.length, 1, 'exactly one message goes out')
  assert.equal(sent[0][1], '5', 'the computed answer — just the number')
  assert.equal(['A', 'B', 'C'].includes(sent[0][0]), true, 'from the first maxBots pool bots')
  assert.equal(job.running, false, 'no number round is started')
  job.feed('Solve: 3x+5=20 | Reward: $2,500', { bots: ['A', 'B', 'C', 'D'], maxBots: 3 })
  assert.equal(sent.length, 1, 'a repeated banner line is not answered twice')
  job.feed('Solve: 2x=10', { bots: ['A', 'B'], maxBots: 5 })
  assert.equal(sent.length, 2, 'a new equation is a new round')
  assert.equal(sent[1][1], '5')
  assert.equal(c.timers.size, 0, 'an equation needs no timer')
})

test('an equation steals the round from a stale number game and skips dead bots', () => {
  const c = clock(), sent = []
  // Only B is connected: the manager walks the pool until a bot can speak,
  // and only the message that actually goes out is recorded.
  const job = createChatGameManager({ ...c, now: () => c.time, submit: (id, v) => {
    if (id !== 'B') return false
    sent.push([id, v])
    return true
  } })
  job.feed('Hint: 1-100', { bots: ['A', 'B'], intervalMs: 100 })
  assert.equal(job.running, true)
  job.feed('Solve: 2x=10', { bots: ['A', 'B'], maxBots: 5 })
  assert.equal(job.running, false, 'the stale number round is over')
  assert.equal(sent.filter(([, v]) => v === '5').length, 1, 'still exactly one answer')
  assert.equal(sent.find(([, v]) => v === '5')[0], 'B', 'it comes from the one bot that can speak')
})

// ── /ege allowlists & bot-scripts ─────────────────────────────────────────

test('item globs keep enchanted golden apples out of the dispose list', () => {
  const globs = parseItemGlobs('experience_bottle,golden_apple,shield,totem_of_undying,*shulker_box')
  const match = (name, displayName) => itemMatchesGlobs({ name, displayName: displayName || name }, globs)
  assert.equal(match('golden_apple', 'Golden Apple'), true)
  assert.equal(match('enchanted_golden_apple', 'Enchanted Golden Apple'), false, 'an exact glob must never eat the enchanted ones')
  assert.equal(match('experience_bottle', 'Bottle o Enchanting'), true, 'the registry name is what matches')
  assert.equal(match('shield'), true)
  assert.equal(match('totem_of_undying', 'Totem of Undying'), true)
  assert.equal(match('red_shulker_box', 'Red Shulker Box'), true, '*shulker_box catches every colour')
  assert.equal(match('blue_shulker_box'), true)
  assert.equal(match('diamond_sword', 'Diamond Sword'), false, 'only the allowed junk moves')
  assert.equal(itemMatchesGlobs({ name: 'shield' }, []), false, 'an empty allowlist moves nothing')
  assert.equal(itemMatchesGlobs(null, globs), false)
})

test('parseRewardSlots keeps order and drops junk', () => {
  assert.deepEqual(parseRewardSlots('21,15,13,11'), [21, 15, 13, 11])
  assert.deepEqual(parseRewardSlots(' 21 , nope , 15 '), [21, 15])
  assert.deepEqual(parseRewardSlots(''), [])
  assert.deepEqual(parseRewardSlots(undefined), [])
})

test('script lines carry target selectors and skip comments', () => {
  assert.equal(parseScriptLine('# a comment'), null)
  assert.equal(parseScriptLine('   '), null)
  assert.equal(parseScriptLine('*123'), null, 'a selector with no command is ignored')
  assert.deepEqual(parseScriptLine('hello'), { target: { kind: 'self', pattern: '' }, command: 'hello' })
  assert.deepEqual(parseScriptLine('*123 /kits'), { target: { kind: 'match', pattern: '123' }, command: '/kits' })
  assert.deepEqual(parseScriptLine('* say hi && sleep 1s && say bye'), { target: { kind: 'all', pattern: '' }, command: 'say hi && sleep 1s && say bye' })
  assert.deepEqual(selectScriptBots('123', ['ab123cd', 'AB123', 'nope']), ['ab123cd', 'AB123'])
  assert.deepEqual(selectScriptBots('', ['a', 'b']), ['a', 'b'], 'an empty pattern matches every name')
  assert.equal(parseScript('# c\nhello\n\n*B one').length, 2)
})

test('loadBotScript reads a script and refuses to escape its folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-scripts-unit-'))
  fs.writeFileSync(path.join(dir, 'demo.txt'), '# demo\nhello\n*B one\n')
  const ok = loadBotScript(dir, 'demo')
  assert.equal(ok.ok, true)
  assert.equal(ok.steps.length, 2)
  assert.deepEqual(listBotScripts(dir), ['demo'])
  assert.equal(loadBotScript(dir, '../demo').ok, false, 'path tricks are rejected')
  assert.equal(loadBotScript(dir, 'missing').ok, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('command suggestions follow the web GUI match rule', () => {
  const commands = { '/all <cmd>': 'broadcast', '/all-slow [d] <cmd>': 'slow', '/kits': 'claim', '/list': 'status' }
  assert.deepEqual(commandSuggestions('/al', commands).map(m => m.key), ['/all <cmd>', '/all-slow [d] <cmd>'])
  assert.deepEqual(commandSuggestions('/kits', commands).map(m => m.key), ['/kits'])
  assert.deepEqual(commandSuggestions('/kits ', commands).map(m => m.key), ['/kits'], 'a trailing space never hides the match')
  assert.deepEqual(commandSuggestions('hello', commands), [])
  assert.deepEqual(commandSuggestions('/zzz', commands), [])
})


test('parseProxyGroups reads indexed PROXY_GROUP_N_* vars including sparse indexes', () => {
  const env = {
    PROXY_GROUP_1_BOTS: 'Alice, Bob',
    PROXY_GROUP_1_HOST: '1.2.3.4',
    PROXY_GROUP_1_PORT: '1081',
    PROXY_GROUP_1_TYPE: 'http',
    PROXY_GROUP_2_BOTS: 'Carol',
    PROXY_GROUP_2_HOST: '5.6.7.8',
    // no PORT/TYPE -> defaults
    PROXY_GROUP_4_BOTS: 'Dave', // gap at 3 is valid
    PROXY_GROUP_4_HOST: '9.9.9.9'
  }
  const groups = parseProxyGroups(env)
  assert.deepEqual(groups, [
    { index: 1, bots: ['Alice', 'Bob'], host: '1.2.3.4', port: 1081, type: 'http', user: '', pass: '', loginPassword: '', fallbackPassword: '' },
    { index: 2, bots: ['Carol'], host: '5.6.7.8', port: 1080, type: 'socks5', user: '', pass: '', loginPassword: '', fallbackPassword: '' },
    { index: 4, bots: ['Dave'], host: '9.9.9.9', port: 1080, type: 'socks5', user: '', pass: '', loginPassword: '', fallbackPassword: '' }
  ])
})

test('parseProxyGroups skips a group with no bots', () => {
  const env = { PROXY_GROUP_1_BOTS: '', PROXY_GROUP_1_HOST: '1.2.3.4' }
  assert.deepEqual(parseProxyGroups(env), [])
  assert.deepEqual(parseProxyGroups({}), [])
})

test('a group with bots but no HOST still exists, so its login password applies', () => {
  // This is the shape that used to be dropped in silence: a group used only to
  // separate accounts, carrying its own /login password and no proxy of its own.
  const env = { PROXY_GROUP_1_BOTS: 'BotA,BotB', PROXY_GROUP_1_LOGIN_PASSWORD: 'group-pw' }
  const groups = parseProxyGroups(env)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].host, '', 'no dedicated proxy')
  assert.equal(groups[0].loginPassword, 'group-pw')
  assert.deepEqual(resolveLoginPassword('BotA', groups, env), { password: 'group-pw', source: 'PROXY_GROUP_1_LOGIN_PASSWORD' })
  // …and the bots use the default route rather than a made-up host:port.
  const fallback = { host: 'default-host', port: 1080, type: 'socks5' }
  assert.deepEqual(resolveBotProxy('BotA', groups, fallback), fallback)
  assert.equal(resolveBotProxy('BotA', groups, null), null)
})

test('a group numbered above a gap remains reachable with its account password', () => {
  const env = { PROXY_GROUP_2_BOTS: 'BotA', PROXY_GROUP_2_LOGIN_PASSWORD: 'group-pw' }
  const groups = parseProxyGroups(env)
  assert.equal(groups[0].index, 2)
  assert.equal(resolveLoginPassword('BotA', groups, env).password, 'group-pw')
  assert.deepEqual(findIgnoredProxyGroupVars(env, groups), [])
  // Declaring group 1 as well is what makes group 2 reachable.
  const fixed = { PROXY_GROUP_1_BOTS: 'BotZ', PROXY_GROUP_1_HOST: 'h', ...env }
  assert.equal(parseProxyGroups(fixed).length, 2)
})

test('findIgnoredProxyGroupVars names every group variable that belongs to no group', () => {
  const env = {
    PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: 'h',
    // 2 is missing entirely, but 3 still works
    PROXY_GROUP_3_BOTS: 'B', PROXY_GROUP_3_HOST: 'h2', PROXY_GROUP_3_LOGIN_PASSWORD: 'pw',
    PROXY_HOST: 'not-a-group', PROXY_GROUPS: 'not-a-group-either'
  }
  const groups = parseProxyGroups(env)
  assert.equal(groups.length, 2)
  assert.deepEqual(findIgnoredProxyGroupVars(env, groups), [])
  assert.deepEqual(findIgnoredProxyGroupVars({ PROXY_GROUP_9_HOST: 'admission-only' }, groups), ['PROXY_GROUP_9_HOST'])
  // A fully parsed set is reported as nothing ignored.
  assert.deepEqual(findIgnoredProxyGroupVars(env, [{ index: 1 }, { index: 3 }]), [])
  assert.deepEqual(findIgnoredProxyGroupVars({}, []), [])
})

test('resolveBotProxy matches the group containing the bot', () => {
  const groups = parseProxyGroups({
    PROXY_GROUP_1_BOTS: 'Alice,Bob', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_PORT: '1081', PROXY_GROUP_1_TYPE: 'http',
    PROXY_GROUP_2_BOTS: 'Carol', PROXY_GROUP_2_HOST: '5.6.7.8'
  })
  assert.deepEqual(resolveBotProxy('Bob', groups), { host: '1.2.3.4', port: 1081, type: 'http', user: '', pass: '', group: 1 })
  assert.deepEqual(resolveBotProxy('Carol', groups), { host: '5.6.7.8', port: 1080, type: 'socks5', user: '', pass: '', group: 2 })
})

test('resolveBotProxy falls back when unmatched, disabled, or empty', () => {
  const groups = parseProxyGroups({ PROXY_GROUP_1_BOTS: 'Alice', PROXY_GROUP_1_HOST: '1.2.3.4' })
  const fallback = { host: 'global-host', port: 1080, type: 'socks5' }
  assert.deepEqual(resolveBotProxy('Zed', groups, fallback), fallback)
  assert.equal(resolveBotProxy('Zed', groups, null), null)
  assert.equal(resolveBotProxy('Alice', [], fallback), fallback)
  assert.equal(resolveBotProxy('Alice', undefined, fallback), fallback)
})

test('parseProxyGroups gives each group its own credentials', () => {
  const groups = parseProxyGroups({
    PROXY_GROUP_1_BOTS: 'Alice', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_USER: 'alice', PROXY_GROUP_1_PASS: 'group-one-secret',
    PROXY_GROUP_2_BOTS: 'Bob', PROXY_GROUP_2_HOST: '5.6.7.8', PROXY_GROUP_2_PASS: 'password-only'
  })
  assert.deepEqual(groups[0], { index: 1, bots: ['Alice'], host: '1.2.3.4', port: 1080, type: 'socks5', user: 'alice', pass: 'group-one-secret', loginPassword: '', fallbackPassword: '' })
  // A username-less group is legal — some SOCKS5 setups authenticate on the password alone.
  assert.deepEqual(groups[1], { index: 2, bots: ['Bob'], host: '5.6.7.8', port: 1080, type: 'socks5', user: '', pass: 'password-only', loginPassword: '', fallbackPassword: '' })
})

test('parseProxyGroups accepts _PASSWORD as a spelling of _PASS, and _PASS wins when both are set', () => {
  const alias = parseProxyGroups({ PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: 'h', PROXY_GROUP_1_PASSWORD: 'via-alias' })
  assert.equal(alias[0].pass, 'via-alias')
  const both = parseProxyGroups({ PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: 'h', PROXY_GROUP_1_PASS: 'primary', PROXY_GROUP_1_PASSWORD: 'alias' })
  assert.equal(both[0].pass, 'primary')
  // An explicitly empty _PASS is a real value: it must not fall through to the alias.
  const empty = parseProxyGroups({ PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: 'h', PROXY_GROUP_1_PASS: '', PROXY_GROUP_1_PASSWORD: 'alias' })
  assert.equal(empty[0].pass, '')
})

test('resolveBotProxy carries the matched group credentials and defaults them to empty', () => {
  const groups = parseProxyGroups({
    PROXY_GROUP_1_BOTS: 'Alice', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_USER: 'u1', PROXY_GROUP_1_PASS: 'p1',
    PROXY_GROUP_2_BOTS: 'Bob', PROXY_GROUP_2_HOST: '5.6.7.8'
  })
  assert.deepEqual(resolveBotProxy('Alice', groups), { host: '1.2.3.4', port: 1080, type: 'socks5', user: 'u1', pass: 'p1', group: 1 })
  assert.deepEqual(resolveBotProxy('Bob', groups), { host: '5.6.7.8', port: 1080, type: 'socks5', user: '', pass: '', group: 2 })
  // A group never inherits the global password — credentials belong to a target.
  const globalFallback = { host: 'global', port: 1080, type: 'socks5', user: 'globaluser', pass: 'globalsecret' }
  assert.deepEqual(resolveBotProxy('Bob', groups).pass, '')
  assert.deepEqual(resolveBotProxy('Zed', groups, globalFallback), globalFallback)
})

test('proxyAuthHeader builds HTTP Basic auth only when credentials exist', () => {
  assert.equal(proxyAuthHeader(null), '')
  assert.equal(proxyAuthHeader({ host: 'h', port: 1 }), '')
  assert.equal(proxyAuthHeader({ host: 'h', port: 1, user: '', pass: '' }), '')
  assert.equal(proxyAuthHeader({ user: 'alice', pass: 's3cret' }), 'Basic ' + Buffer.from('alice:s3cret').toString('base64'))
  // Password-only still encodes the empty username rather than omitting the header.
  assert.equal(proxyAuthHeader({ pass: 'only' }), 'Basic ' + Buffer.from(':only').toString('base64'))
  // Non-ASCII credentials must survive the round trip as utf8, not latin1.
  const utf8 = proxyAuthHeader({ user: 'Bjorn', pass: 'pässwörd' })
  assert.equal(Buffer.from(utf8.slice('Basic '.length), 'base64').toString('utf8'), 'Bjorn:pässwörd')
})

test('buildHttpConnectRequest sends the auth header only when credentialed, and always ends with a blank line', () => {
  const plain = buildHttpConnectRequest('mc.example.com', 25565, { host: 'p', port: 8080, type: 'http' })
  assert.equal(plain, 'CONNECT mc.example.com:25565 HTTP/1.1\r\nHost: mc.example.com:25565\r\nConnection: keep-alive\r\n\r\n')
  assert.ok(!/Proxy-Authorization/i.test(plain), 'no empty auth header — some proxies answer 407 for one')

  const authed = buildHttpConnectRequest('mc.example.com', 25565, { host: 'p', port: 8080, type: 'http', user: 'alice', pass: 's3cret' })
  const expected = 'Basic ' + Buffer.from('alice:s3cret').toString('base64')
  assert.ok(authed.includes(`Proxy-Authorization: ${expected}\r\n`))
  assert.ok(authed.endsWith('Connection: keep-alive\r\n\r\n'))
  // The header must land before the terminating blank line, or the proxy reads it as the body.
  assert.ok(authed.indexOf('Proxy-Authorization') < authed.indexOf('\r\n\r\n'))
})

test('describeProxy shows the target but never proxy credentials', () => {
  assert.equal(describeProxy(null), 'direct (no proxy)')
  assert.equal(describeProxy({ host: '1.2.3.4', port: 1080, type: 'socks5' }), 'SOCKS5 1.2.3.4:1080')
  assert.equal(describeProxy({ host: '1.2.3.4', port: 8080, type: 'http', user: 'alice', pass: 'hunter2' }), 'HTTP ***@1.2.3.4:8080')
  // Password-only: no username to show, but the URL must not silently look credential-free.
  assert.equal(describeProxy({ host: '1.2.3.4', port: 1080, type: 'socks5', pass: 'hunter2' }), 'SOCKS5 ***@1.2.3.4:1080')
  const rendered = describeProxy({ host: 'h', port: 1, type: 'http', user: 'alice', pass: 'hunter2' })
  assert.ok(!rendered.includes('hunter2'), 'the password must never appear in a log line')
  assert.ok(!rendered.includes('alice'), 'the username must never appear in a log line')
})

test('hasProxyAuth is true for a username or a password, false otherwise', () => {
  assert.equal(hasProxyAuth(null), false)
  assert.equal(hasProxyAuth({}), false)
  assert.equal(hasProxyAuth({ user: '', pass: '' }), false)
  assert.equal(hasProxyAuth({ user: 'u' }), true)
  assert.equal(hasProxyAuth({ pass: 'p' }), true)
})

test('parseProxyGroups reads the per-group Minecraft account password', () => {
  const groups = parseProxyGroups({
    PROXY_GROUP_1_BOTS: 'Alice,Bob', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_LOGIN_PASSWORD: 'group-one-account-pw',
    PROXY_GROUP_2_BOTS: 'Carol', PROXY_GROUP_2_HOST: '5.6.7.8'
  })
  assert.equal(groups[0].loginPassword, 'group-one-account-pw')
  assert.equal(groups[1].loginPassword, '')
  // It is the ACCOUNT password, so it must not be confused with the proxy login.
  assert.equal(groups[0].user, '')
  assert.equal(groups[0].pass, '')
})

test('the account password is not trimmed or otherwise rewritten', () => {
  // Trimming would silently change a password that legitimately has a space and
  // lock the account out of its own /login.
  const groups = parseProxyGroups({ PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: 'h', PROXY_GROUP_1_LOGIN_PASSWORD: ' pw with spaces ' })
  assert.equal(groups[0].loginPassword, ' pw with spaces ')
})

test('resolveLoginPassword prefers the group, then LOGIN_PASSWORD, then the built-in default', () => {
  const groups = parseProxyGroups({
    PROXY_GROUP_1_BOTS: 'Alice,Bob', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_LOGIN_PASSWORD: 'group-pw',
    PROXY_GROUP_2_BOTS: 'Carol', PROXY_GROUP_2_HOST: '5.6.7.8'
  })
  const env = { LOGIN_PASSWORD: 'global-pw' }

  assert.deepEqual(resolveLoginPassword('Alice', groups, env), { password: 'group-pw', source: 'PROXY_GROUP_1_LOGIN_PASSWORD' })
  // A group that sets no account password falls back to the global one…
  assert.deepEqual(resolveLoginPassword('Carol', groups, env), { password: 'global-pw', source: 'LOGIN_PASSWORD' })
  // …and so does a bot in no group at all.
  assert.deepEqual(resolveLoginPassword('Zed', groups, env), { password: 'global-pw', source: 'LOGIN_PASSWORD' })
  // No groups configured and no env: the long-standing default, unchanged.
  assert.deepEqual(resolveLoginPassword('Alice', [], {}), { password: '123456', source: 'built-in default' })
  assert.deepEqual(resolveLoginPassword('Alice', undefined, {}), { password: '123456', source: 'built-in default' })
  // An empty LOGIN_PASSWORD means unset, not "empty password".
  assert.deepEqual(resolveLoginPassword('Alice', [], { LOGIN_PASSWORD: '' }), { password: '123456', source: 'built-in default' })
})

test('resolveLoginPassword never returns the proxy password as an account password', () => {
  const groups = parseProxyGroups({
    PROXY_GROUP_1_BOTS: 'Alice', PROXY_GROUP_1_HOST: '1.2.3.4',
    PROXY_GROUP_1_USER: 'proxy-user', PROXY_GROUP_1_PASS: 'proxy-secret'
  })
  const result = resolveLoginPassword('Alice', groups, { LOGIN_PASSWORD: 'global-pw' })
  assert.equal(result.password, 'global-pw')
  assert.notEqual(result.password, 'proxy-secret')
})

test('parseBotPasswords reads both spellings, first colon splits, no trimming', () => {
  const map = parseBotPasswords({
    BOT_PASSWORDS: 'BotOne:secret-one , BotTwo:has:colons,BotThree:spaces kept ,broken,',
    BOT_PASSWORD_BotFour: 'has,comma'
  })
  // The password after the colon survives byte for byte, including a trailing
  // space: silently trimming it would turn a correct credential into a server
  // "wrong password" that cannot be reproduced by typing it.
  assert.deepEqual(map.get('botone'), { bot: 'BotOne', password: 'secret-one ', source: 'BOT_PASSWORDS' })
  // Only the first colon separates: a password may contain colons.
  assert.equal(map.get('bottwo').password, 'has:colons')
  // The space BEFORE a name is separator formatting and is dropped; the one
  // inside the password is not.
  assert.equal(map.get('botthree').password, 'spaces kept ')
  // An entry with no ':' and an empty entry are both skipped, not fatal.
  assert.equal(map.size, 4)
  assert.equal(map.get('botfour').password, 'has,comma')
  assert.equal(map.get('botfour').source, 'BOT_PASSWORD_BotFour')
})

test('the per-name variable wins over the BOT_PASSWORDS list, and lookup is case-insensitive', () => {
  const map = parseBotPasswords({ BOT_PASSWORDS: 'BotOne:from-list', BOT_PASSWORD_BotOne: 'from-name' })
  assert.equal(map.get('botone').password, 'from-name')
  assert.equal(map.get('botone').source, 'BOT_PASSWORD_BotOne')
  // Whatever the casing in .env or in BOT_NAMES, one entry is found: the map is
  // keyed lowercase and resolveLoginPassword lowercases the bot name to look it
  // up, so BOT_PASSWORD_botone serves bot BotOne instead of silently missing and
  // falling through to a different password (which reads as "wrong password").
  assert.equal(parseBotPasswords({ BOT_PASSWORD_botone: 'x' }).get('botone').password, 'x')
  assert.equal(parseBotPasswords({ BOT_PASSWORDS: 'BOTONE:x' }).get('botone').password, 'x')
  assert.equal(parseBotPasswords({}).size, 0)
  assert.equal(parseBotPasswords({ BOT_PASSWORDS: '' }).size, 0)
})

test('resolveLoginPassword puts a per-bot password above the group and the global', () => {
  const env = { LOGIN_PASSWORD: 'global-pw', BOT_PASSWORDS: 'BotTwo:own-pw,BotFour:also-own' }
  const groups = parseProxyGroups({
    PROXY_GROUP_1_BOTS: 'BotOne,BotTwo,BotThree', PROXY_GROUP_1_HOST: 'h', PROXY_GROUP_1_LOGIN_PASSWORD: 'group-pw'
  })
  assert.deepEqual(resolveLoginPassword('BotTwo', groups, env), { password: 'own-pw', source: 'BOT_PASSWORDS' })
  assert.deepEqual(resolveLoginPassword('BotOne', groups, env), { password: 'group-pw', source: 'PROXY_GROUP_1_LOGIN_PASSWORD' })
  assert.deepEqual(resolveLoginPassword('BotThree', groups, env), { password: 'group-pw', source: 'PROXY_GROUP_1_LOGIN_PASSWORD' })
  assert.deepEqual(resolveLoginPassword('BotFour', groups, env), { password: 'also-own', source: 'BOT_PASSWORDS' })
  assert.deepEqual(resolveLoginPassword('Stranger', groups, env), { password: 'global-pw', source: 'LOGIN_PASSWORD' })
})

test('resolveFallbackPassword finds the group fallback, then the global one, else null', () => {
  const groups = parseProxyGroups({
    PROXY_GROUP_1_BOTS: 'Alice,Bob', PROXY_GROUP_1_HOST: '1.2.3.4',
    PROXY_GROUP_1_LOGIN_PASSWORD: 'group-pw', PROXY_GROUP_1_FALLBACK_LOGIN_PASSWORD: 'group-fallback',
    PROXY_GROUP_2_BOTS: 'Carol', PROXY_GROUP_2_HOST: '5.6.7.8', PROXY_GROUP_2_LOGIN_PASSWORD: 'pw'
  })
  assert.equal(groups[0].fallbackPassword, 'group-fallback', 'parsed next to the primary password')
  const env = { LOGIN_PASSWORD_FALLBACK: 'global-fallback' }
  // The group's fallback beats the global one…
  assert.deepEqual(resolveFallbackPassword('Alice', groups, env), { password: 'group-fallback', source: 'PROXY_GROUP_1_FALLBACK_LOGIN_PASSWORD' })
  // …a group without one falls through to the global fallback…
  assert.deepEqual(resolveFallbackPassword('Carol', groups, env), { password: 'global-fallback', source: 'LOGIN_PASSWORD_FALLBACK' })
  assert.deepEqual(resolveFallbackPassword('Zed', groups, env), { password: 'global-fallback', source: 'LOGIN_PASSWORD_FALLBACK' })
  // …and with nothing configured there is nothing to fall back to, so the
  // failure guard behaves exactly as it did before this existed.
  assert.equal(resolveFallbackPassword('Zed', groups, {}), null)
  assert.equal(resolveFallbackPassword('Zed', [], { LOGIN_PASSWORD_FALLBACK: '' }), null)
})

test('classifyAuthReply recognises the real failure wordings and nothing else', () => {
  const bad = ['Wrong password!', 'Incorrect password', 'Invalid password', 'Password does not match', 'Passwords do not match', 'Authentication failed', 'Login failed', 'That password is not correct', 'Your password is too short']
  for (const text of bad) assert.equal(classifyAuthReply(text).kind, 'bad-password', text)

  assert.equal(classifyAuthReply('Too many failed attempts, please wait').kind, 'throttled')
  assert.equal(classifyAuthReply('Please wait 30 seconds before trying again').kind, 'throttled')
  assert.equal(classifyAuthReply('You have been temporarily blocked from logging in').kind, 'throttled')
  assert.equal(classifyAuthReply('Try again later').kind, 'throttled')

  // An existing session is not a credential verdict: the previous connection may
  // simply not have expired yet, which is normal on a fast reconnect.
  assert.equal(classifyAuthReply('You are already logged in!').kind, 'already')
  assert.equal(classifyAuthReply('This name is already registered').kind, 'already')

  for (const text of ['Welcome to the server', 'Please login using /login <password>', 'Type /register to create an account', '', 'Built by Notch']) {
    assert.equal(classifyAuthReply(text), null, text)
  }
})

test('classifyAuthReply reports the matched phrase, and prefers the specific pattern', () => {
  assert.equal(classifyAuthReply('Wrong password! Try again later.').reason, 'Wrong password')
  assert.equal(classifyAuthReply('Too many failed attempts, please wait 10 seconds before trying again').kind, 'throttled')
})

test('nextAuthFailure makes a wrong password sticky and escalates repeated throttling', () => {
  const bad = nextAuthFailure(null, { kind: 'bad-password', reason: 'Wrong password' }, 1000)
  assert.deepEqual(bad, { kind: 'bad-password', reason: 'Wrong password', at: 1000, until: null, count: 1 })

  // Throttled is tolerated twice, then treated as a wrong password so that no
  // amount of "try again later" becomes an endless retry loop.
  const first = nextAuthFailure(null, { kind: 'throttled', reason: 'Too many attempts' }, 1000, { throttleMs: 5000, maxThrottled: 2 })
  assert.equal(first.kind, 'throttled')
  assert.equal(first.until, 6000)
  const second = nextAuthFailure(first, { kind: 'throttled', reason: 'Too many attempts' }, 7000, { throttleMs: 5000, maxThrottled: 2 })
  assert.equal(second.kind, 'throttled')
  assert.equal(second.until, 12000)
  const third = nextAuthFailure(second, { kind: 'throttled', reason: 'Too many attempts' }, 13000, { throttleMs: 5000, maxThrottled: 2 })
  assert.equal(third.kind, 'bad-password')
  assert.equal(third.until, null)
  assert.match(third.reason, /repeated 3 times/)
})

test('nextAuthFailure only pauses on "already", and isAuthBlocked honours the deadline', () => {
  const already = nextAuthFailure(null, { kind: 'already', reason: 'already logged in' }, 1000, { alreadyMs: 60000 })
  assert.equal(already.kind, 'already')
  assert.equal(already.until, 61000)
  assert.equal(isAuthBlocked(already, 1000), true)
  assert.equal(isAuthBlocked(already, 60999), true)
  assert.equal(isAuthBlocked(already, 61000), false)

  const sticky = { kind: 'bad-password', until: null }
  assert.equal(isAuthBlocked(sticky, 1), true)
  assert.equal(isAuthBlocked(sticky, Number.MAX_SAFE_INTEGER), true)
  assert.equal(isAuthBlocked(null, 1), false)
})

test('multi-task createSlowBroadcastManager: concurrent tasks, independent timers, selective cancellation, and cancelAll', () => {
  const c = clock()
  const manager = createSlowBroadcastManager(c)
  assert.equal(manager.running, false)
  assert.deepEqual(manager.list(), [])

  const dispatches1 = []
  const done1 = []
  const id1 = manager.start(['A', 'B', 'C'], 10, botId => {
    dispatches1.push([botId, c.time])
    return true
  }, { command: 'first', onDone: r => done1.push(r) })

  assert.equal(id1, 1)
  assert.equal(manager.running, true)
  assert.deepEqual(dispatches1, [['A', 0]])

  const dispatches2 = []
  const done2 = []
  const id2 = manager.start(['X', 'Y'], 25, botId => {
    dispatches2.push([botId, c.time])
    return true
  }, { command: 'second', onDone: r => done2.push(r) })

  assert.equal(id2, 2)
  assert.deepEqual(dispatches2, [['X', 0]])
  assert.equal(c.timers.size, 2)

  const list = manager.list()
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 1)
  assert.equal(list[0].command, 'first')
  assert.equal(list[1].id, 2)
  assert.equal(list[1].command, 'second')

  // Advance 10ms: task 1 dispatches B
  c.tick(10)
  assert.deepEqual(dispatches1, [['A', 0], ['B', 10]])
  assert.deepEqual(dispatches2, [['X', 0]])

  // Cancel task 1 selectively
  assert.equal(manager.cancel(id1), true)
  assert.equal(manager.cancel(999), false)
  assert.equal(manager.running, true)

  // Advance 15ms more (c.time = 25): task 2 dispatches Y and finishes
  c.tick(15)
  assert.deepEqual(dispatches2, [['X', 0], ['Y', 25]])
  assert.deepEqual(done2, [{ taskId: 2, sent: 2, skipped: 0 }])
  assert.equal(done1.length, 0) // task 1 was cancelled
  assert.equal(manager.running, false)
  assert.equal(c.timers.size, 0)

  // Test cancelAll
  const id3 = manager.start(['M', 'N'], 50, () => true)
  const id4 = manager.start(['P', 'Q'], 50, () => true)
  assert.equal(manager.running, true)
  assert.equal(manager.cancelAll(), 2)
  assert.equal(manager.running, false)
  assert.equal(c.timers.size, 0)
})

test('parseDataArgs defaults to push and reads subcommands', () => {
  assert.deepEqual(parseDataArgs(''), { action: 'push', unknown: null })
  assert.deepEqual(parseDataArgs(undefined), { action: 'push', unknown: null })
  assert.deepEqual(parseDataArgs('   '), { action: 'push', unknown: null })
  assert.deepEqual(parseDataArgs(' check '), { action: 'check', unknown: null })
  assert.deepEqual(parseDataArgs('CHECK'), { action: 'check', unknown: null })
  assert.deepEqual(parseDataArgs('doctor'), { action: 'check', unknown: null })
  assert.deepEqual(parseDataArgs('status'), { action: 'status', unknown: null })
})

// A typo must never silently start a real push without saying so.
test('parseDataArgs reports an unknown option but still pushes', () => {
  assert.deepEqual(parseDataArgs('chekc'), { action: 'push', unknown: 'chekc' })
  assert.deepEqual(parseDataArgs('pussh now'), { action: 'push', unknown: 'pussh' })
  assert.deepEqual(parseDataArgs('CHECK extra'), { action: 'check', unknown: null })
})


// ── /dump argument grammar, item matching, and the hidden-dump scheduler ─────
const { parseDumpArgs, tokenizeDumpArgs, itemMatchesDumpTerms, dumpContainerBlockNames, buildHiddenDumpQueue, createDumpSlotScheduler } = require('../bot-controls')

test('parseDumpArgs reads every documented /dump example', () => {
  assert.deepEqual(parseDumpArgs('hidden "fatal" shulker'), { mode: 'hidden', terms: ['fatal'], types: ['shulker'], colors: [], unknown: [] })
  assert.deepEqual(parseDumpArgs('hidden "sword"'), { mode: 'hidden', terms: ['sword'], types: [], colors: [], unknown: [] })
  assert.deepEqual(parseDumpArgs('hidden "chestplate" chest'), { mode: 'hidden', terms: ['chestplate'], types: ['chest'], colors: [], unknown: [] })
  assert.deepEqual(parseDumpArgs('"fatal" shulker yellow'), { mode: 'tpa', terms: ['fatal'], types: ['shulker'], colors: ['yellow'], unknown: [] })
  assert.deepEqual(parseDumpArgs('"fatal" "enchanted" shulker chest'), { mode: 'tpa', terms: ['fatal', 'enchanted'], types: ['shulker', 'chest'], colors: [], unknown: [] })
  assert.deepEqual(parseDumpArgs('"netherite"'), { mode: 'tpa', terms: ['netherite'], types: [], colors: [], unknown: [] })
  assert.deepEqual(parseDumpArgs('shulker'), { mode: 'tpa', terms: [], types: ['shulker'], colors: [], unknown: [] })
  assert.deepEqual(parseDumpArgs(''), { mode: 'tpa', terms: [], types: [], colors: [], unknown: [] })
})

test('parseDumpArgs: quoted is always a term, bare words are keywords first, typos warn', () => {
  // Quotes force a term — /dump "chest" searches, /dump chest filters
  assert.deepEqual(parseDumpArgs('"shulker"').terms, ['shulker'])
  assert.deepEqual(parseDumpArgs('"shulker"').types, [])
  assert.deepEqual(parseDumpArgs('"chest"').types, [])
  // A bare non-keyword is a term (/find parity)
  assert.deepEqual(parseDumpArgs('sword').terms, ['sword'])
  assert.deepEqual(parseDumpArgs('chestplate').terms, ['chestplate'])
  // A keyword typo is reported, never silently turned into a term
  assert.deepEqual(parseDumpArgs('hiden').unknown, ['hiden'])
  assert.deepEqual(parseDumpArgs('hiden').terms, [])
  // A bare colour implies the shulker type
  assert.deepEqual(parseDumpArgs('yellow'), { mode: 'tpa', terms: [], types: ['shulker'], colors: ['yellow'], unknown: [] })
  // Colour spelling variants fold together
  assert.deepEqual(parseDumpArgs('"fatal" shulker light-blue').colors, ['light_blue'])
  assert.deepEqual(parseDumpArgs('shulker grey').colors, ['gray'])
  // A second mode keyword is reported, the first wins
  assert.deepEqual(parseDumpArgs('hidden home'), { mode: 'hidden', terms: [], types: [], colors: [], unknown: ['home'] })
})

test('tokenizeDumpArgs keeps quoted phrases together and supports single quotes', () => {
  assert.deepEqual(tokenizeDumpArgs('"fatal sword" shulker'), [{ text: 'fatal sword', quoted: true }, { text: 'shulker', quoted: false }])
  assert.deepEqual(tokenizeDumpArgs("'enchanted golden'"), [{ text: 'enchanted golden', quoted: true }])
  assert.deepEqual(tokenizeDumpArgs(''), [])
})

test('itemMatchesDumpTerms matches names and NBT, OR across terms, case-insensitive', () => {
  const names = ['Fatal Chestplate', 'netherite_chestplate']
  assert.equal(itemMatchesDumpTerms(names, '', ['fatal']), true, 'display name, case-insensitive')
  assert.equal(itemMatchesDumpTerms(names, '', ['Netherite']), true, 'registry name')
  assert.equal(itemMatchesDumpTerms(['Fatal Chestplate'], '{"Material":"netherite"}', ['netherite']), true, 'material tag in NBT')
  assert.equal(itemMatchesDumpTerms(names, '', ['zzz', 'fatal']), true, 'OR across terms')
  assert.equal(itemMatchesDumpTerms(names, '', ['zzz']), false)
  assert.equal(itemMatchesDumpTerms(names, '', []), true, 'no filter = everything')
  assert.equal(itemMatchesDumpTerms(['Light Sword'], '', ['light sword']), true, 'separator folding')
  assert.equal(itemMatchesDumpTerms(null, null, ['fatal']), false)
})

test('dumpContainerBlockNames picks the allowed container families', () => {
  const all = dumpContainerBlockNames([], [])
  assert.ok(all.includes('chest') && all.includes('trapped_chest') && all.includes('shulker_box') && all.includes('yellow_shulker_box'))
  assert.deepEqual(dumpContainerBlockNames(['shulker'], ['yellow']), ['yellow_shulker_box'], 'colour narrows shulker boxes')
  assert.deepEqual(dumpContainerBlockNames(['chest'], []), ['chest', 'trapped_chest'], 'chest family only')
  const shulkerAll = dumpContainerBlockNames(['shulker'], [])
  assert.ok(shulkerAll.includes('cyan_shulker_box') && !shulkerAll.includes('chest'))
})

test('buildHiddenDumpQueue includes every bot once in shuffled order', () => {
  const queue = buildHiddenDumpQueue(['A', 'B', 'C', 'D', 'E', 'A', ''], () => 0.9)
  assert.equal(queue.length, 5)
  assert.deepEqual(new Set(queue), new Set(['A', 'B', 'C', 'D', 'E']))
})

test('createDumpSlotScheduler never exceeds the cap and spaces starts', () => {
  const timers = []
  const setTimer = (fn, delay) => { const t = { fn, delay }; timers.push(t); return t }
  const clearTimer = t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) }
  const fire = () => { while (timers.length) timers.shift().fn() }
  const activeSet = new Set()
  const completions = {}
  let maxActive = 0, idleCount = 0
  const scheduler = createDumpSlotScheduler({
    maxConcurrent: 2,
    gapMs: () => 1000,
    setTimer,
    clearTimer,
    start: (name, fin) => {
      activeSet.add(name)
      maxActive = Math.max(maxActive, activeSet.size)
      completions[name] = () => { activeSet.delete(name); fin() }
    },
    onIdle: () => { idleCount++ }
  })
  scheduler.enqueue(['A', 'B', 'C', 'D', 'E'])
  // The gap is armed before the first job even starts: one start per tick.
  assert.deepEqual(Object.keys(completions), ['A'])
  fire()
  assert.deepEqual(Object.keys(completions), ['A', 'B'], 'cap 2 reached')
  fire()
  assert.deepEqual(Object.keys(completions), ['A', 'B'], 'cap holds — no third start')
  completions.A()
  assert.deepEqual(Object.keys(completions), ['A', 'B', 'C'], 'a freed slot starts the next job')
  completions.A() // double-done must not free a second slot
  assert.equal(scheduler.stats().finished, 1)
  completions.B()
  completions.C()
  fire() // gap tick → D, then its gap tick → E
  completions.D()
  fire()
  completions.E()
  assert.equal(maxActive, 2, 'never more than maxConcurrent at once')
  assert.deepEqual(scheduler.stats(), { active: 0, queued: 0, started: 5, finished: 5, cancelled: false })
  assert.equal(idleCount, 1, 'onIdle fires exactly once')
})

test('createDumpSlotScheduler gap 0 fills the cap immediately and cancel drops the queue', () => {
  const timers = []
  const setTimer = (fn, delay) => { const t = { fn, delay }; timers.push(t); return t }
  const clearTimer = t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) }
  const started = []
  let idleCount = 0
  const scheduler = createDumpSlotScheduler({
    maxConcurrent: 3,
    gapMs: () => 0,
    setTimer,
    clearTimer,
    start: (name, fin) => { started.push(name); fin() },
    onIdle: () => { idleCount++ }
  })
  scheduler.enqueue(['A', 'B', 'C', 'D', 'E'])
  assert.deepEqual(started, ['A', 'B', 'C', 'D', 'E'], 'instant jobs with no gap drain the whole queue')
  assert.equal(idleCount, 1)

  const started2 = []
  const fins = {}
  const scheduler2 = createDumpSlotScheduler({
    maxConcurrent: 1,
    gapMs: () => 0,
    setTimer,
    clearTimer,
    start: (name, fin) => { started2.push(name); fins[name] = fin }
  })
  scheduler2.enqueue(['X', 'Y', 'Z'])
  assert.deepEqual(started2, ['X'])
  scheduler2.cancel()
  fins.X()
  assert.deepEqual(started2, ['X'], 'cancel drops every queued job')
  assert.equal(scheduler2.running, false)
})
