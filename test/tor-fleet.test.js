'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { torEndpoint, readTorExitIp, verifyTorRotation, createAllBannedTorRotation } = require('../tor-fleet')
const proxy = { host: 'localhost', port: 9150, type: 'socks5' }
const endpoint = torEndpoint(proxy)
test('only controllable local SOCKS routes are Tor candidates', () => {
  assert.equal(endpoint.controlPort, 9151)
  for (const value of [null, { ...proxy, host: 'proxy.example' }, { ...proxy, type: 'http' }, { ...proxy, port: 65535 }]) assert.equal(torEndpoint(value), null)
  assert.equal(torEndpoint({ ...proxy, host: '127.0.0.1' }).key, endpoint.key)
})
test('NEWNYM acknowledgement is not success: verify a valid changed IP after settling', async () => {
  const calls = [], ips = ['198.51.100.1', '198.51.100.1', '198.51.100.2']
  const result = await verifyTorRotation(endpoint, { probe: async () => ips.shift(), signal: async port => { calls.push(port); return { ok: true } }, wait: async ms => { assert.equal(ms, 10000) } })
  assert.equal(result.ok, true)
  assert.equal(result.attempt, 2)
  assert.deepEqual(calls, [9151, 9151])
  const unchanged = await verifyTorRotation(endpoint, { probe: async () => '198.51.100.1', signal: async () => ({ ok: true }), wait: async () => {} })
  assert.equal(unchanged.ok, false)
  assert.match(unchanged.error, /unchanged/)
  let signals = 0
  const unavailable = await verifyTorRotation(endpoint, { probe: async () => { throw Error('probe offline') }, signal: async () => { signals++; return { ok: true } } })
  assert.equal(unavailable.ok, false)
  assert.equal(signals, 0)
  const denied = await verifyTorRotation(endpoint, { probe: async () => '198.51.100.1', signal: async () => ({ ok: false, error: 'auth rejected' }) })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /auth rejected/)
})
test('SOCKS IP probe validates output and uses bounded argument-based execution', async () => {
  const run = (command, args, options, cb) => {
    assert.equal(command, 'curl')
    assert.ok(args.includes('--socks5-hostname'))
    assert.ok(args.includes('127.0.0.1:9150'))
    assert.equal(options.timeout, 10000)
    cb(null, '198.51.100.3\n')
  }
  assert.equal(await readTorExitIp(endpoint, { run }), '198.51.100.3')
  await assert.rejects(readTorExitIp(endpoint, { run: (_c, _a, _o, cb) => cb(null, '<html>error</html>') }), /valid IP/)
  await assert.rejects(readTorExitIp(endpoint, { run: (_c, _a, _o, cb) => cb(Error('secret details')) }), /probe failed/)
})
test('rotate only when every assigned account is banned, once per episode, never other routes', async () => {
  let time = 0
  const rows = [
    { id: 'A', proxy, banned: true, bannedAt: 1 },
    { id: 'B', proxy: { ...proxy, host: '127.0.0.1' }, banned: false },
    { id: 'C', proxy: { ...proxy, port: 9250 }, banned: false },
    { id: 'Direct', proxy: null, banned: true }
  ]
  const calls = []
  const manager = createAllBannedTorRotation({ snapshot: () => rows, now: () => time, rotate: async e => { calls.push(e.port); return { ok: true, before: '198.51.100.1', after: '198.51.100.2' } } })
  assert.deepEqual(await manager.check(), [])
  rows[1].banned = true; rows[1].bannedAt = 2
  assert.equal((await manager.check())[0].ok, true)
  assert.deepEqual(calls, [9150])
  time = 600000; await manager.check(); assert.equal(calls.length, 1)
  rows[0].online = true; await manager.check()
  rows[0].online = false; await manager.check(); assert.equal(calls.length, 2)
  assert.equal(rows[0].banned, true, 'rotation must not lift account bans')
})
test('in-flight deduplication and cooldown prevent NEWNYM storms; failures retry later', async () => {
  let time = 0, release, calls = 0
  const manager = createAllBannedTorRotation({ snapshot: () => [{ id: 'A', proxy, banned: true }], now: () => time, rotate: async () => { calls++; return new Promise(resolve => { release = resolve }) } })
  const first = manager.check()
  assert.deepEqual(await manager.check(), [])
  release({ ok: false, error: 'unchanged' }); await first
  await manager.check(); assert.equal(calls, 1)
  time = 300000
  const retry = manager.check(); assert.equal(calls, 2)
  release({ ok: true }); await retry
  const disabled = createAllBannedTorRotation({ snapshot: () => { throw Error('should not inspect') }, enabled: () => false })
  assert.deepEqual(await disabled.check(), [])
})
test('a ban wave trips past the share threshold, not only when every bot is banned', async () => {
  let time = 0
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `B${i}`, proxy, banned: i < 8, bannedAt: i < 8 ? i + 1 : 0 }))
  const calls = [], restarts = []
  const manager = createAllBannedTorRotation({
    snapshot: () => rows, now: () => time,
    rotate: async e => { calls.push(e.port); return { ok: true, before: '198.51.100.1', after: '198.51.100.2' } },
    restart: async e => { restarts.push(e.port); return { ok: true, before: '198.51.100.1', after: '198.51.100.9' } }
  })
  assert.deepEqual(await manager.check(), [], '8 of 10 is exactly 80% — not MORE than 80%')
  rows[8].banned = true; rows[8].bannedAt = 11
  await manager.check()
  assert.deepEqual(calls, [9150], '9 of 10 (>80%) fires even though one bot is still unbanned')
  assert.deepEqual(restarts, [], 'a verified NEWNYM never escalates to the restart fallback')
  // A stricter threshold re-arms the question: 1.0 means "all or nothing".
  const strict = createAllBannedTorRotation({
    snapshot: () => rows, now: () => time, threshold: () => 1,
    rotate: async () => { calls.push(9999); return { ok: true, before: 'a', after: 'b' } }
  })
  time = 900000
  await strict.check()
  assert.deepEqual(calls, [9150], 'threshold 1.0 does not fire at 9 of 10')
  rows[9].banned = true; rows[9].bannedAt = 12
  await strict.check()
  assert.equal(calls.length, 2, 'but every bot banned always fires')
})
test('an unverifiable NEWNYM escalates to the Tor restart fallback and stays honest', async () => {
  let time = 0
  const restarts = []
  const manager = createAllBannedTorRotation({
    snapshot: () => [{ id: 'A', proxy, banned: true, bannedAt: 1 }], now: () => time,
    rotate: async () => ({ ok: false, before: '198.51.100.1', error: 'SOCKS probe exit IP unchanged after 3 NEWNYM attempts' }),
    restart: async e => { restarts.push(e.port); return { ok: true, before: '198.51.100.1', after: '198.51.100.9' } }
  })
  const [result] = await manager.check()
  assert.equal(result.ok, true)
  assert.equal(result.restarted, true)
  assert.deepEqual(restarts, [9150])
  assert.equal(result.after, '198.51.100.9', 'the restart\'s proven exit is what gets reported')
  // Both halves failing keeps the episode open — retried after cooldown with
  // the combined reason, never marked done.
  let attempts = 0
  const stubborn = createAllBannedTorRotation({
    snapshot: () => [{ id: 'A', proxy, banned: true, bannedAt: 1 }], now: () => time,
    rotate: async () => { attempts++; return { ok: false, before: '198.51.100.1', error: 'unchanged after NEWNYM' } },
    restart: async () => ({ ok: false, before: '198.51.100.1', after: '198.51.100.1', error: 'restart completed but the exit is STILL 198.51.100.1' })
  })
  const [failed] = await stubborn.check()
  assert.equal(failed.ok, false)
  assert.match(failed.error, /unchanged after NEWNYM.*STILL 198\.51\.100\.1/)
  await stubborn.check()
  assert.equal(attempts, 1, 'cooldown gates the retry')
  time = 300000
  await stubborn.check()
  assert.equal(attempts, 2, 'a failed episode is retried after cooldown, not marked completed')
  // Without a restart fallback the original failure stands alone.
  const lonely = createAllBannedTorRotation({
    snapshot: () => [{ id: 'A', proxy, banned: true, bannedAt: 1 }], now: () => 0,
    rotate: async () => ({ ok: false, error: 'Tor control rejected NEWNYM' })
  })
  const [bare] = await lonely.check()
  assert.equal(bare.ok, false)
  assert.match(bare.error, /Tor control rejected NEWNYM/)
})
test('verification talks to a real isolated Tor control protocol server', async t => {
  const net = require('node:net')
  const server = net.createServer(socket => {
    let input = ''
    socket.on('data', chunk => {
      input += chunk
      if (input.includes('QUIT\r\n')) {
        assert.match(input, /^AUTHENTICATE\r\nSIGNAL NEWNYM\r\nQUIT\r\n$/)
        socket.end('250 OK\r\n250 OK\r\n250 closing connection\r\n')
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const ips = ['198.51.100.1', '198.51.100.2']
  const result = await verifyTorRotation({ ...endpoint, controlPort: server.address().port }, { probe: async () => ips.shift(), wait: async () => {} })
  assert.equal(result.ok, true)
})
