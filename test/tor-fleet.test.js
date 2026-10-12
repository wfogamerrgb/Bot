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
