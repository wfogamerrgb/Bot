'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const controls = require('../bot-controls')
const plain = value => JSON.parse(JSON.stringify(value))

// Evaluate the actual entry point with network/game dependencies mocked. No bot
// connections, disk history writes, or process-wide handlers are started.
function runtime(env = {}) {
  const timers = new Map()
  const createdBots = []
  const authAlerts = []
  // Two HTTP servers run in production (dashboard, analytics) on different
  // ports, so handlers are routed by the port each one listens on. "Last
  // created" would let startAnalyticsServer() shadow the dashboard.
  const handlers = new Map()
  let dashboardHandler
  const wss = new EventEmitter()
  const server = new EventEmitter()
  server.listen = (_port, _bind, cb) => cb()
  const fakeWs = { OPEN: 1, Server: function () { return wss } }
  wss.handleUpgrade = (_req, socket, _head, cb) => cb(socket)
  const setTimer = (fn, delay) => { const t = { fn, delay, unref() {} }; timers.set(t, t); return t }
  const clearTimer = t => timers.delete(t)
  // Its own cron state file per runtime: `/cron add` now persists jobs, and a
  // shared path would leak jobs between tests (and write into the repo).
  const cronStateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-cron-')), 'cron-jobs.json')
  // Same isolation for the persistent state files: tests mutate dataState and
  // trigger real saves (saveState writes DATA_FILE via a tmp file), and those
  // must land in a temp dir — never in the repo, and never in a live install's
  // data/ directory (root-owned on the server: "EACCES ... data/spawner-data
  // .json.tmp", which failed 'the removed list gates reconnecting…').
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-data-'))
  const stateEnv = {
    DATA_FILE: path.join(stateDir, 'spawner-data.json'),
    REMOVED_BOTS_FILE: path.join(stateDir, 'removed-bots.json'),
    EVIDENCE_FILE: path.join(stateDir, 'evidence.json'),
    TIMESERIES_FILE: path.join(stateDir, 'timeseries.jsonl'),
    TIMESERIES_SUMMARY_FILE: path.join(stateDir, 'timeseries-summary.json')
  }
  const processMock = {
    // MC_WEB_AUTO_BUILD is forced off here (the app default is ON): with it on,
// a /play request for an unbuilt client would clone and build the real
// multi-GB upstream client from the test suite. Tests that need a build point
// MC_WEB_CLIENT_DIR at a temp dir instead.
  env: { BOT_NAMES: 'A,B,C', WEB_GUI: 'true', TUI_GUI: 'false', WEB_PASSWORD: 'test-only', WEB_TERMINAL_LOG: 'false', MC_WEB_AUTO_BUILD: 'false', CRON_STATE_FILE: cronStateFile, ...stateEnv, ...env },
    stdout: { isTTY: false, write() {} }, stderr: { write() {} },
    on() {}, exit() {}, memoryUsage: () => ({ rss: 0, heapUsed: 0 }), uptime: () => 1
  }
  const settingsModule = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'settings.js'), 'utf8'), { require, module: settingsModule, process: processMock, __dirname: path.join(__dirname, '..') })
  const fakeFiles = new Map()
  if (env.TEST_ROBOT_TEXT != null) fakeFiles.set('robot.txt', env.TEST_ROBOT_TEXT)
  const fakeFs = {
    readFileSync(file) { const name = path.basename(file); if (fakeFiles.has(name)) return fakeFiles.get(name); if (['robot.txt', 'removed.txt'].includes(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return '' },
    writeFileSync(file, content) { fakeFiles.set(path.basename(file), content) },
    appendFileSync(file, content) { const name = path.basename(file); fakeFiles.set(name, (fakeFiles.get(name) || '') + content) },
    mkdirSync() {}, renameSync(from, to) { fakeFiles.set(path.basename(to), fakeFiles.get(path.basename(from))); fakeFiles.delete(path.basename(from)) }, unlinkSync(file) { fakeFiles.delete(path.basename(file)) }, existsSync: () => false
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8')
  const context = vm.createContext({
    Buffer, URL, URLSearchParams, console, process: processMock, __dirname: path.join(__dirname, '..'),
    setTimeout: setTimer, clearTimeout: clearTimer,
    setInterval: setTimer, clearInterval: clearTimer, setImmediate: fn => setTimer(fn, 0),
    require(name) {
      if (name === 'dotenv') return { config() {} }
      if (name === 'fs') return fakeFs
      if (name === path.join(__dirname, '..', 'settings')) return settingsModule.exports
      if (name === 'http') {
        return {
          createServer(fn) {
            if (!dashboardHandler) dashboardHandler = fn
            return Object.assign(server, {
              listen(port, _bind, cb) { handlers.set(String(port), fn); if (cb) cb() }
            })
          }
        }
      }
      if (name === 'ws') return fakeWs
      if (name === './bot-controls') return {
        ...controls,
        createSlowBroadcast: () => controls.createSlowBroadcast({ setTimer, clearTimer }),
        createSlowBroadcastManager: () => controls.createSlowBroadcastManager({ setTimer, clearTimer }),
        // Same reason as the broadcasts: the chat-game round must tick on the
        // harness clock, not on real setTimeout.
        createChatGameManager: (opts = {}) => controls.createChatGameManager({ ...opts, setTimer, clearTimer }),
        // Same reason: the hidden-dump slot scheduler must pace on the harness
        // clock, not on real setTimeout.
        createDumpSlotScheduler: (opts = {}) => controls.createDumpSlotScheduler({ ...opts, setTimer, clearTimer }),
        // bot-controls reads the real process.env by default, but inside this
        // harness bot.js reads processMock.env — so the group vars have to be
        // parsed from the same object bot.js sees, exactly as they would be in
        // production where there is only one process.env.
        parseProxyGroups: (env = processMock.env) => controls.parseProxyGroups(env),
        // Same reason: BOT_PASSWORDS is read out of bot.js's own env at startup.
        parseBotPasswords: (env = processMock.env) => controls.parseBotPasswords(env)
      }
      if (name === './expose-terminal') return { sshConfig: () => ({ enabled: false }) }
      if (name === './monitoring') return {
        // A ban verdict that matches nothing, so the kick path stays exercised
        // without a live connection.
        classifyKick: message => ({ banned: false, permanent: false, kind: '', duration: '', durationMs: 0, expiresAt: 0, reason: String(message ?? ''), caseId: '', text: String(message ?? '') }),
        // Alerts are recorded rather than dropped: "alert once" is a property of
        // the auth guard, so it has to be observable from a test.
        createMonitoring: () => ({ getMemorySnapshot: () => null, onDisconnect() {}, onKick() {}, onBan() {}, onAuthFailure(botId, failure) { authAlerts.push({ botId, failure }) }, onProxyStall() {}, onReconnectExhausted() {}, onFatal() {}, onSecurityLockout() {}, inspectServerMessage() {}, onRecovered() {} })
      }
      // Resolved against this test file, not against bot.js, so it needs an entry.
      if (name === './removed-bots') return require('../removed-bots')
      if (name === './server-commands') return require('../server-commands')
      if (name === './generated-bots') return require('../generated-bots')
      if (name === './coinflip-dashboard-static') return require('../coinflip-dashboard-static')
      if (name === './xterm-static') return require('../xterm-static')
      if (name === './ai-chat') return require('../ai-chat')
      if (name === './bot-manual') return () => ({ routeCommand: () => false, key() {}, onWindowOpen: () => false, onWindowClose() {}, stopManualMode() {}, snapshotFor: () => null })
      if (name === 'mineflayer') return { createBot() {
        if (!env.TEST_CREATE_BOTS) throw Error('Live bot connections forbidden in tests')
        const bot = new EventEmitter()
        const client = new EventEmitter()
        Object.assign(client, { write() {}, state: 'play', socket: { remoteAddress: '203.0.113.2', remotePort: 25565 } })
        Object.assign(bot, { _client: client, loadPlugin() {}, quit() {}, entity: { position: { x: 1, y: 64, z: 2 } } })
        createdBots.push(bot)
        return bot
      } }
      if (name === 'mineflayer-armor-manager') return () => {}
      if (name === 'mineflayer-pathfinder') return { goals: {} }
      if (name === 'socks') return {}
      if (name === './cron') return require('../cron')
      if (name === './web-client') return require('../web-client')
      if (name === './docs') return require('../docs')
      return require(name)
    }
  })
  vm.runInContext(source.slice(0, source.indexOf('// ── Interface startup')), context)
  const run = code => vm.runInContext(code, context)
  const initialOrder = Array.from(run('initialBotOrder'))
  timers.clear()
  run('initialPending = 0')
  run(`
    for (const id of ['A', 'B', 'C']) bots[id] = {
      bot: { entity: {}, health: 20, food: 20, chat(msg) { chats.push([id, msg]) } },
      logs: [], disconnectManually() {}
    }
    activeId = 'A'
  `)
  context.chats = []
  run('webHandle = startWebGUI()')
  // `port` selects the server to talk to: by default the dashboard, or the
  // analytics port for the analytics routes.
  async function request(url, body = '', cookie = '', method = 'POST', port = null, headers = {}, remote = '127.0.0.1') {
    const handler = port == null ? dashboardHandler : handlers.get(String(port))
    if (!handler) throw new Error(`No test HTTP handler listening on ${port}`)
    const req = new EventEmitter()
    Object.assign(req, { url, method, headers: { host: 'localhost', cookie, ...headers }, socket: { remoteAddress: remote } })
    const response = { status: 0, headers: {}, body: '', writeHead(s, h = {}) { this.status = s; this.headers = h }, end(b = '') { this.body = b } }
    const done = handler(req, response)
    if (body) req.emit('data', Buffer.from(body))
    req.emit('end')
    await done
    return response
  }
  async function login() {
    const res = await request('/login', 'password=test-only')
    assert.equal(res.status, 303)
    return res.headers['Set-Cookie'].split(';')[0]
  }
  function socket(cookie, headers = {}, remote = '127.0.0.1') {
    const ws = new EventEmitter()
    Object.assign(ws, { readyState: 1, messages: [], send(text) { this.messages.push(JSON.parse(text)) }, ping() {}, write() {}, destroy() { this.destroyed = true }, close(code) { this.closeCode = code; this.readyState = 3; this.emit('close', code) } })
    server.emit('upgrade', { url: '/ws', headers: { host: 'localhost', cookie, ...headers }, socket: { remoteAddress: remote } }, ws, Buffer.alloc(0))
    ws.command = msg => ws.emit('message', JSON.stringify(msg))
    return ws
  }
  return { context, run, timers, initialOrder, request, login, socket, authAlerts, createdBots, fakeFiles }
}

test('dashboard commands admit robot.txt names without touching the .env roster; admission errors close without reconnect', async () => {
  const r = runtime({ TEST_CREATE_BOTS: true, TEST_ROBOT_TEXT: 'A\na\nD\n', LOGIN_PASSWORD: 'pw', CLICK_COMPASS: 'false' })
  const ws = r.socket(await r.login())
  ws.command({ t: 'cmd', text: '/start-login', selectedId: 'A' })
  assert.equal(r.createdBots.length, 1)
  assert.equal(r.run('Object.keys(bots).join(",")'), 'A,B,C,D')
  const bot = r.createdBots[0]
  const sent = []; bot.chat = cmd => sent.push(cmd)
  bot.emit('spawn')
  const startup = [...r.timers.keys()].find(t => t.delay >= 3000 && t.delay <= 5000)
  startup.fn()
  assert.deepEqual(sent, [], 'no setup commands before authentication')
  bot.emit('messagestr', 'Please /login password')
  const auth = [...r.timers.keys()].find(t => t.delay === 250); auth.fn()
  assert.deepEqual(sent, ['/login pw'])
  bot.emit('messagestr', 'Successfully logged in!')
  assert.equal(sent[1], '/server lifesteal')
  bot.emit('error', Error('admission failure'))
  assert.equal(r.run('Boolean(bots.D)'), false)
  assert.match(r.fakeFiles.get('removed.txt'), /^D\t# /)
  ws.command({ t: 'cmd', text: '/start-login', selectedId: 'A' })
  assert.equal(r.createdBots.length, 1)
})
test('robot success waits through normal AFK setup, cancels fallback and keeps the successful candidate on reconnect', () => {
  const r = runtime({ TEST_CREATE_BOTS: true, TEST_ROBOT_TEXT: 'D', LOGIN_PASSWORD: 'wrong', LOGIN_PASSWORD_1: 'right', CLICK_COMPASS: 'false' })
  r.run(`handleCommand('/start-login')`)
  const bot = r.createdBots[0], sent = []
  bot.chat = cmd => sent.push(cmd)
  bot.emit('spawn')
  // Fire the stable-backoff timer first; both it and AFK use 60 seconds.
  const stable = [...r.timers.keys()].find(t => t.delay === r.run("settings.get('RECONNECT_STABLE_MS')")); r.timers.delete(stable); stable.fn()
  bot.emit('messagestr', 'Please /login password')
  const auth = [...r.timers.keys()].find(t => t.delay === 250); r.timers.delete(auth); auth.fn()
  bot.emit('messagestr', 'Wrong password')
  const fallback = [...r.timers.keys()].find(t => t.delay === 1500); r.timers.delete(fallback); fallback.fn()
  bot.emit('messagestr', 'Successfully logged in')
  assert.deepEqual(sent.slice(0, 3), ['/login wrong', '/login right', '/server lifesteal'])
  assert.equal(r.run(`robotLogin.isAdmitting('D')`), true)
  const afk = [...r.timers.keys()].find(t => t.delay === 60000 && String(t.fn).includes('timeouts.indexOf')); r.timers.delete(afk); afk.fn()
  assert.equal(sent.at(-1), '/warp afk')
  // Fire setup timers on the harness clock; both selector readiness and AFK
  // admission grace use five seconds.
  for (const t of [...r.timers.keys()].filter(t => t.delay === 5000 && String(t.fn).includes('timeouts.indexOf'))) { r.timers.delete(t); t.fn() }
  assert.equal(r.run(`robotLogin.isAdmitting('D')`), false)
  bot.emit('end', 'later network error')
  assert.equal(r.fakeFiles.has('removed.txt'), false)
  assert.ok(r.run(`bots.D.reconnectTimer`))
  assert.equal(r.run(`planAuthAction('D', 'Please /login password', 1000).command`), '/login right')
})

test('dashboard RTP commands reuse existing connections, accept ranges and stop cleanly', async () => {
  const r = runtime({ BOT_RTP_BOTS: 'A,Missing' })
  r.run(`bots.A.bot.entity.position = { x: 0, y: 64, z: 0 }; bots.A.bot.on = () => {}; bots.A.bot.removeListener = () => {}`)
  const ws = r.socket(await r.login())
  ws.command({ t: 'cmd', text: '/start-rtp', selectedId: 'A' })
  assert.equal(r.createdBots.length, 0)
  assert.deepEqual(plain(r.context.chats), [['A', '/rtp world world']])
  assert.match(channelLogs(r, 'A'), /Missing: queued connection/)
  assert.equal(r.run(`pendingRtp.has('Missing')`), true)
  ws.command({ t: 'cmd', text: '/stop-rtp 1-1', selectedId: 'A' })
  assert.equal(r.run('bots.A.rtpRunning'), false)
})
test('login starts while .env attempts remain pending', () => {
  const r = runtime({ TEST_CREATE_BOTS: true, TEST_ROBOT_TEXT: 'D', LOGIN_PASSWORD: 'pw' })
  r.run(`initialPending = 74; handleCommand('/start-login')`)
  assert.equal(r.createdBots.length, 1)
  assert.equal(r.run('initialPending'), 74)
})
test('RTP connects missing accounts once and waits for setup; stopping cancels pending starts', () => {
  const r = runtime({ TEST_CREATE_BOTS: true, BOT_RTP_BOTS: 'D', CLICK_COMPASS: 'false' })
  r.run(`handleCommand('/start-rtp'); handleCommand('/start-rtp')`)
  const queued = r.run(`pendingRtp.get('D').timer`)
  r.timers.delete(queued); queued.fn()
  assert.equal(r.createdBots.length, 1)
  const bot = r.createdBots[0], sent = []; bot.chat = cmd => sent.push(cmd)
  bot.emit('spawn')
  const waiting = r.run(`pendingRtp.get('D').timer`); r.timers.delete(waiting); waiting.fn()
  assert.equal(sent.length, 0, 'must not RTP at the login/selector spawn')
  r.run(`bots.D.normalStartupReady = true`)
  const ready = r.run(`pendingRtp.get('D').timer`); r.timers.delete(ready); ready.fn()
  assert.deepEqual(sent, ['/rtp world world'])
  assert.equal(r.run('bots.D.rtpRunning'), true)
  r.run(`handleCommand('/stop-rtp'); handleCommand('/start-rtp E'); handleCommand('/stop-rtp')`)
  assert.equal(r.run('pendingRtp.size'), 0)
  assert.equal(r.createdBots.length, 1)
})
test('overview never queries or reports disconnected bots with stale avatars', async () => {
  const r = runtime()
  r.run(`bots.B.connectionState = 'disconnected'; queryBalance = async (id) => { chats.push([id, 'probe']); return 1 }; queryRank = async () => 'Member'; handleCommand('/overview')`)
  for (let n = 0; n < 8; n++) await Promise.resolve()
  assert.equal(r.context.chats.some(([id]) => id === 'B'), false)
  assert.doesNotMatch(channelLogs(r, 'A'), /Offline \/ Connecting|\[2\].*B/)
  assert.match(channelLogs(r, 'A'), /\[3\].*C/)
})
test('server command packets reach authenticated command browser and TUI without executing chat', async () => {
  const r = runtime({ TEST_CREATE_BOTS: true })
  r.run(`createBotInstance('D')`)
  r.createdBots[0]._client.emit('declare_commands', { nodes: [{ children: [1] }, { flags: { command_node_type: 1 }, extraNodeData: { name: 'warp' }, children: [] }], rootIndex: 0 })
  const cookie = await r.login()
  const res = await r.request('/api/server-commands?bot=D', '', cookie, 'GET')
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body).commands, [{ command: '/warp', usages: ['/warp'] }])
  assert.equal(JSON.parse(res.body).source, 'tree')
  r.run(`handleCommand('/server-commands', { selectedId: 'D' })`)
  assert.match(channelLogs(r, 'D'), /\/warp/)
  assert.deepEqual(plain(r.context.chats), [])
  assert.equal(r.run(`commandTableFor('D')['/warp'].startsWith('Server command')`), true)
  const anonymous = await r.request('/api/server-commands?bot=D', '', '', 'GET')
  assert.equal(anonymous.status, 303)
})
test('shared TUI logs, history and settings never expose auth or proxy credentials or terminal escapes', async () => {
  const r = runtime({ LOGIN_PASSWORD: 'login-secret', PROXY_PASS: 'proxy-secret', PROXY_USER: 'proxy-user', PROXY_GROUP_2_PASS: 'group-secret' })
  const cookie = await r.login()
  for (const command of ['/chat /login login-secret', '/env set PROXY_PASS next-secret', '/env set PROXY_GROUP_2_PASS next-group-secret', '/chat /register abc abc']) { r.context.text = command; r.run('recordHistory(text); handleCommand(text)') }
  r.run(`logFor('A', 'server echo login-secret next-secret next-group-secret proxy-user \\x1b[2Jmalicious'); recordHistory('/login short')`)
  const res = await r.request('/api/state', '', cookie, 'GET')
  assert.doesNotMatch(res.body, /login-secret|next-secret|next-group-secret|proxy-user|\\u001b|\/login short|\/register abc/)
  assert.match(res.body, /redacted/)
  const settings = await r.request('/api/settings', '', cookie, 'GET')
  assert.doesNotMatch(settings.body, /next-secret|next-group-secret|proxy-user/)
})
test('origin guard allows tunnels and proxies but keeps blocking CSRF', async () => {
  const r = runtime({ WEB_ALLOWED_ORIGINS: 'https://allowed.example' }), cookie = await r.login()
  const run = (headers, remote = '127.0.0.1') => r.request('/api/command', '{}', cookie, 'POST', null, headers, remote)
  const connect = (headers, remote = '127.0.0.1') => r.socket(cookie, headers, remote)
  // The cases a rewritten-Host tunnel/proxy produces; every one must get past
  // the guard and reach normal authentication.
  for (const headers of [
    { host: 'localhost', origin: 'http://127.0.0.1:80' },
    { host: 'localhost:80', origin: 'https://bot.tunnel.example', 'sec-fetch-site': 'same-origin' },
    { host: 'localhost:80', origin: 'https://bot.tunnel.example', 'x-forwarded-host': 'bot.tunnel.example' },
    { host: 'localhost:80', origin: 'https://allowed.example' },
    { host: '52.237.167.218', origin: 'http://52.237.167.218' }
  ]) {
    assert.notEqual((await run(headers)).status, 403, JSON.stringify(headers))
    assert.equal(connect(headers).destroyed, undefined, JSON.stringify(headers))
  }
  // Cross-site CSRF, opaque origins and a cross-site flag stay blocked.
  for (const headers of [
    { host: 'localhost', origin: 'https://evil.example' },
    { host: 'localhost', origin: 'null' },
    { host: 'localhost:80', origin: 'https://bot.tunnel.example', 'sec-fetch-site': 'cross-site' }
  ]) {
    assert.equal((await run(headers)).status, 403, JSON.stringify(headers))
    assert.equal(connect(headers).destroyed, true, JSON.stringify(headers))
  }
  // A loopback-looking Origin arriving from a remote peer is not a tunnel.
  const spoof = { host: 'evil.example', origin: 'http://127.0.0.1:81' }
  assert.equal((await run(spoof, '203.0.113.9')).status, 403)
  assert.equal(connect(spoof, '203.0.113.9').destroyed, true)
})
test('foreign-origin mutations and websocket upgrades are rejected; logout revokes existing sockets', async () => {
  const r = runtime(), cookie = await r.login()
  const foreign = await r.request('/api/command', JSON.stringify({ text: 'attack' }), cookie, 'POST', null, { origin: 'https://evil.example' })
  assert.equal(foreign.status, 403)
  const bad = r.socket(cookie, { origin: 'https://evil.example' })
  assert.equal(bad.destroyed, true)
  const good = r.socket(cookie, { origin: 'http://localhost' })
  good.command({ t: 'cmd', text: 'safe' })
  assert.deepEqual(plain(r.context.chats), [['A', 'safe']])
  await r.request('/logout', '', cookie)
  assert.equal(good.closeCode, 1008)
  good.command({ t: 'cmd', text: 'after logout' })
  assert.equal(r.context.chats.length, 1)
  const urlToken = await r.request('/api/state?token=' + cookie.slice(4), '', '', 'GET')
  assert.equal(urlToken.status, 303, 'URL tokens must not leak through access logs/referrers')
})
test('new-gen saves generated roster and proxy groups before staggered connections', async () => {
  const r = runtime({ TEST_CREATE_BOTS: true, LOGIN_PASSWORD: 'pw', PROXY_GROUP_2_HOST: 'proxy' })
  const cookie = await r.login()
  const res = await r.request('/api/command', JSON.stringify({ text: '/new-gen 3' }), cookie)
  assert.equal(res.status, 202)
  const saved = require('dotenv').parse(r.fakeFiles.get('.env'))
  const names = saved.PROXY_GROUP_2_BOTS.split(',')
  assert.equal(names.length, 3)
  assert.equal(r.createdBots.length, 0, 'saving precedes every connection')
  assert.ok(names.every(name => saved.BOT_NAMES.includes(name) && /^[A-Za-z0-9_]{3,16}$/.test(name)))
  const timer = [...r.timers.keys()].find(t => t.delay === 0 && String(t.fn).includes('createBotInstance(name)'))
  timer.fn()
  assert.equal(r.createdBots.length, 1)
  assert.equal(r.run('PROXY_GROUPS[0].index'), 2)
})
test('all-slow dispatches crates-solo once per target and refuses nested fleet commands', async () => {
  const r = runtime()
  r.run(`globalThis.sequences = []; runCratesAllSequenceForBot = async (id, block, plan) => sequences.push({ id, plan }); handleCommand('/all-slow 1-3 500ms /crates-solo dump=off afk=off')`)
  for (let n = 0; n < 5; n++) {
    const timer = [...r.timers.keys()].find(t => t.delay === 500)
    if (!timer) break
    r.timers.delete(timer); timer.fn(); await Promise.resolve()
  }
  assert.deepEqual(plain(r.run('sequences.map(s => s.id)')), ['A', 'B', 'C'])
  assert.deepEqual(plain(r.context.chats), [])
  r.run(`handleCommand('/all /crates-all delay=30s')`)
  assert.equal(r.run('sequences.length'), 3)
  assert.match(channelLogs(r, 'A'), /Fleet-wide command cannot be nested/)
})
test('crates delay schedules solo start and fleet stagger independently of afk delay; env commands change live defaults without leaking credentials', async () => {
  const r = runtime()
  r.timers.clear()
  r.run(`globalThis.sequences = []; runCratesAllSequenceForBot = async (id, block, plan) => sequences.push({ id, plan }); handleCommand('/crates-solo B delay=30s afk=10 dump=off')`)
  assert.equal(r.run('sequences.length'), 0)
  const timer = [...r.timers.keys()].find(t => t.delay === 30000); timer.fn(); await Promise.resolve()
  assert.equal(r.run('sequences[0].id'), 'B')
  assert.equal(r.run('sequences[0].plan.afkDelayMs'), 10000)
  r.timers.clear()
  r.run(`handleCommand('/crates-all 3 delay=2s dump=off afk=off')`)
  assert.deepEqual([...r.timers.keys()].map(t => t.delay).sort((a, b) => a - b), [0, 2000, 4000])
  r.run(`handleCommand('/env set CRATES_ALL_DUMP home'); handleCommand('/env set WARP_COMMAND /warp new'); handleCommand('/env set LOGIN_PASSWORD_1 super-secret-value')`)
  assert.equal(r.run('cratesAllPlan().dump'), 'home')
  assert.equal(r.run('WARP_AFK'), '/warp new')
  assert.doesNotMatch(channelLogs(r, 'A'), /super-secret-value/)
  assert.doesNotMatch(r.run('commandHistory.join("\\n")'), /super-secret-value/)
  r.run(`handleCommand('/env set SHARDSHOP_LOOP_DELAY_MS 1.5s'); handleCommand('/env get SHARDSHOP_LOOP_DELAY_MS')`)
  assert.equal(r.run('SHARDSHOP_LOOP_DELAY_MS'), 1500)
})

test('real bot lifecycle events mark stale avatars offline and persist death evidence', () => {
  const r = runtime({ TEST_CREATE_BOTS: true })
  r.run(`createBotInstance('D', 'game.example', 25565, '1.21.1')`)
  const bot = r.createdBots[0]
  assert.equal(r.run(`bots.D.connectionState`), 'connecting')
  bot.emit('spawn')
  assert.equal(r.run(`botOnline(bots.D)`), true)
  bot.emit('death')
  assert.equal(r.run(`evidenceStore.get('D').deaths.length`), 1)
  bot.emit('kicked', 'Disconnected by server')
  assert.equal(r.run(`botOnline(bots.D)`), false)
  bot.emit('end', 'socketClosed')
  assert.equal(r.run(`bots.D.connectionState`), 'disconnected')
  assert.ok(bot.entity, 'test retains stale avatar to reproduce the actual bug')
  assert.equal(r.run(`bots.D.spawnTime`), null)
})

test('range broadcasts preview without sending, preserve arguments and reject invalid targets', () => {
  const r = runtime()
  r.run(`handleCommand('/all 2-3')`)
  assert.deepEqual(plain(r.context.chats), [])
  r.run(`handleCommand('/all 2-3 /server lifesteal')`)
  assert.deepEqual(plain(r.context.chats), [['B', '/server lifesteal'], ['C', '/server lifesteal']])
  r.context.chats.length = 0
  r.run(`handleCommand('/all-slow B-C 1500ms /server afk')`)
  assert.deepEqual(plain(r.context.chats), [['B', '/server afk']])
  const timer = [...r.timers.values()].find(t => t.delay === 1500)
  assert.ok(timer)
  timer.fn()
  assert.deepEqual(plain(r.context.chats.at(-1)), ['C', '/server afk'])
  r.context.chats.length = 0
  for (const text of ['/all 0-3 /status', '/all 3-2 /status', '/all 1-99 /status']) { r.context.text = text; r.run('handleCommand(text)') }
  assert.deepEqual(plain(r.context.chats), [])
  assert.equal(r.run(`destructiveCommandEffect('/all 2-3 /dc')`), 'disconnects every bot at once')
})

test('served dashboard retains both COINFLIP and PLAY buttons', async () => {
  for (const enabled of ['true', 'false']) {
    const r = runtime({ MC_WEB_ENABLED: enabled }), cookie = await r.login()
    const res = await r.request('/', '', cookie, 'GET')
    const html = res.body.toString('utf8')
    assert.match(html, /id="coinflipbtn"/)
    assert.equal(html.includes('id="playbtn"'), enabled === 'true')
    assert.match(html, /id="show-all-bots" checked/)
  }
})

test('removed permanent bans remain visible without becoming broadcast targets', () => {
  const r = runtime()
  r.run(`removedBotsStore.addRemovedBot(removedBots, { bot: 'Gone', kind: 'permanent', reason: 'Banned by server' })`)
  const removed = plain(r.run('botSnapshot()')).find(b => b.id === 'Gone')
  assert.equal(removed.online, false)
  assert.equal(removed.removed, true)
  assert.equal(removed.banned, true)
  r.run(`handleCommand('/all !hello')`)
  assert.equal(r.context.chats.some(([id]) => id === 'Gone'), false)
})

test('retained avatar does not make ended/banned bot online in dashboard snapshots', async () => {
  const r = runtime(), cookie = await r.login()
  r.run(`bots.B.connectionState = 'disconnected'; bots.B.disconnectedAt = 1234; bots.B.lastDisconnectReason = 'socketClosed'; dataState.bots.B = { bot: 'B', banned: true, banReason: 'Banned by server' }`)
  const snapshot = plain(r.run('botSnapshot()')).find(b => b.id === 'B')
  assert.equal(snapshot.online, false)
  assert.equal(snapshot.connecting, false)
  assert.equal(snapshot.state, 'banned')
  assert.equal(snapshot.number, 2)
  assert.equal(r.run('globalStats().online'), 2)
  r.run(`handleCommand('/all /server afk')`)
  assert.deepEqual(plain(r.context.chats), [['A', '/server afk'], ['C', '/server afk']])
  const res = await r.request('/api/evidence?bot=B', '', cookie, 'GET')
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).current.state, 'banned')
  assert.equal(JSON.parse(res.body).deaths.length, 0)
})

test('connection report distinguishes destination and proxy peer without exposing passwords', () => {
  const r = runtime({ PROXY_HOST: '127.0.0.1', PROXY_PORT: '9050', PROXY_USER: 'secret-user', PROXY_PASS: 'secret-pass' })
  r.run(`bots.A.host = 'game.example'; bots.A.port = 25565; bots.A.bot._client = { socket: { remoteAddress: '127.0.0.1', remotePort: 9050 } }`)
  const info = plain(r.run(`connectionDetails('A', bots.A)`))
  assert.equal(info.route, 'proxied')
  assert.equal(info.serverIp, null)
  assert.equal(info.tcpPeer, '127.0.0.1')
  assert.doesNotMatch(JSON.stringify(info), /secret-user|secret-pass/)
  assert.equal(r.run(`settings.get('CHAT_GAME_AUTO')`), false, 'preserve the user-disabled server default')
})

test('startup randomization defaults on and false/off/0/no preserve configured order', () => {
  assert.equal(runtime().run('RANDOMIZE_BOT_ORDER'), true)
  for (const flag of ['false', 'OFF', '0', 'no', ' false ']) {
    const r = runtime({ RANDOMIZE_BOT_ORDER: flag })
    assert.deepEqual(r.initialOrder, ['A', 'B', 'C'])
    assert.equal(r.run('RANDOMIZE_BOT_ORDER'), false)
  }
})

test('TUI switch supports name/number; invalid targets and bare command do not send chat', () => {
  const r = runtime()
  r.run(`handleCommand('/switch 2')`); assert.equal(r.run('activeId'), 'B')
  r.run(`handleCommand('/switch C')`); assert.equal(r.run('activeId'), 'C')
  for (const text of ['/switch', '/switch 0', '/switch 99', '/switch missing', '/switch __proto__']) r.context.text = text, r.run('handleCommand(text)')
  assert.equal(r.run('activeId'), 'C')
  assert.deepEqual(plain(r.context.chats), [])
})

test('WebSocket switch updates only the requesting client and subsequent command target', async () => {
  const r = runtime(), cookie = await r.login()
  const first = r.socket(cookie), second = r.socket(cookie)
  first.command({ t: 'cmd', text: '/switch 2' })
  assert.deepEqual(first.messages.find(m => m.t === 'select'), { t: 'select', id: 'B' })
  assert.ok(first.messages.some(m => m.t === 'history' && m.id === 'B'))
  assert.equal(second.messages.some(m => m.t === 'select'), false)
  assert.equal(r.run('activeId'), 'A')
  first.command({ t: 'cmd', text: 'hello' })
  second.command({ t: 'cmd', text: 'other tab' })
  assert.deepEqual(plain(r.context.chats), [['B', 'hello'], ['A', 'other tab']])
})

test('HTTP fallback returns selected bot and honors explicit targets without global switching', async () => {
  const r = runtime(), cookie = await r.login()
  let res = await r.request('/api/command', JSON.stringify({ text: '/switch C', selectedId: 'B' }), cookie)
  assert.equal(res.status, 202)
  assert.equal(JSON.parse(res.body).selectedId, 'C')
  assert.equal(r.run('activeId'), 'A')
  await r.request('/api/command', JSON.stringify({ text: 'hello', selectedId: 'C' }), cookie)
  assert.deepEqual(plain(r.context.chats), [['C', 'hello']])
  await r.request('/api/command', JSON.stringify({ text: 'wrong target?', selectedId: 'gone' }), cookie)
  assert.equal(r.context.chats.length, 1)
  res = await r.request('/command', 'text=%2Fswitch+B&selectedId=C', cookie)
  assert.equal(res.headers.Location, '/?view=B')
  assert.equal(r.run('activeId'), 'A')
})

test('actual router handles slow chat, removed/offline bots, local arguments, and exit cancellation', () => {
  const r = runtime({ ALL_SLOW_DELAY_MS: '25' })
  r.timers.clear()
  r.run(`handleCommand('/all-slow !hello')`)
  assert.deepEqual(plain(r.context.chats), [['A', 'hello']])
  assert.equal([...r.timers.values()][0].delay, 25)
  r.run('delete bots.B; bots.C.bot.entity = null')
  const tick = () => { const t = [...r.timers.keys()][0]; r.timers.delete(t); t.fn() }
  tick(); tick()
  assert.equal(r.run('slowBroadcast.running'), false)
  assert.deepEqual(plain(r.context.chats), [['A', 'hello']])
  r.run(`bots.C.bot.entity = {}; runCrateRoutine = (id, color) => chats.push([id, color]); handleCommand('/all-slow /crates purple')`)
  assert.deepEqual(plain(r.context.chats.at(-1)), ['A', 'purple_shulker_box'])
  tick(); assert.deepEqual(plain(r.context.chats.at(-1)), ['C', 'purple_shulker_box'])
  r.run(`handleCommand('/all-slow hello'); handleCommand('/exit'); handleCommand('/exit')`)
  assert.equal(r.run('slowBroadcast.running'), false)
})

test('destructive commands warn first and run only on an exact repeat', () => {
  const r = runtime({ ALL_SLOW_DELAY_MS: '25' })
  const allLogs = () => r.run(`Object.values(bots).flatMap(b => b.logs.map(l => l.text)).join('|')`)
  // First /exit only warns: no exit timer is scheduled and dispatches survive.
  r.run(`handleCommand('/all-slow !hello'); handleCommand('/exit')`)
  assert.match(allLogs(), /DO NOT RUN/)
  assert.ok([...r.timers.values()].every(t => t.delay !== 300), 'first /exit must not schedule the exit')
  assert.equal(r.run('slowBroadcast.running'), true, 'first /exit must not cancel pending dispatches')
  // The identical command again is the explicit go-ahead.
  r.run(`handleCommand('/exit')`)
  assert.ok([...r.timers.values()].some(t => t.delay === 300), 'repeated /exit runs')
  assert.equal(r.run('slowBroadcast.running'), false)
})

test('/all /dc disconnects nothing until the exact command is repeated', () => {
  const r = runtime()
  const allLogs = () => r.run(`Object.values(bots).flatMap(b => b.logs.map(l => l.text)).join('|')`)
  r.run(`handleCommand('/all /dc')`)
  assert.match(allLogs(), /DO NOT RUN/)
  assert.ok(!allLogs().includes('Disconnecting'), 'first /all /dc must not disconnect anyone')
  assert.deepEqual(plain(r.context.chats), [], 'a guarded command never leaks to chat')
  r.run(`handleCommand('/all /dc')`)
  assert.match(allLogs(), /Disconnecting/, 'repeated /all /dc runs on every bot')
})

test('bare broadcasts give usage; normal /all stays immediate', () => {
  const r = runtime()
  r.run(`handleCommand('/all'); handleCommand('/all-slow')`)
  assert.deepEqual(plain(r.context.chats), [])
  r.run(`handleCommand('/all !hello')`)
  assert.deepEqual(plain(r.context.chats), [['A', 'hello'], ['B', 'hello'], ['C', 'hello']])
})

test('ALL_CHAT_GUARD blocks a mistyped /all broadcast; "!" forces chat deliberately', () => {
  const r = runtime()
  // The exposure this guard exists for: one typo, every bot saying it.
  r.run(`handleCommand('/all .server lifesteal')`)
  assert.deepEqual(plain(r.context.chats), [], 'a non-command never reaches chat')
  r.run(`handleCommand('/all-slow .server lifesteal')`)
  assert.deepEqual(plain(r.context.chats), [], '/all-slow is guarded too')
  // Commands pass untouched, and "!" is the deliberate-chat escape hatch.
  r.run(`handleCommand('/all /server lifesteal')`)
  assert.deepEqual(plain(r.context.chats), [['A', '/server lifesteal'], ['B', '/server lifesteal'], ['C', '/server lifesteal']])
  r.run(`handleCommand('/all !hello there')`)
  assert.deepEqual(plain(r.context.chats).slice(-3), [['A', 'hello there'], ['B', 'hello there'], ['C', 'hello there']])
})

test('ALL_CHAT_GUARD=false keeps plain /all chat broadcasts working', () => {
  const r = runtime({ ALL_CHAT_GUARD: 'false' })
  r.run(`handleCommand('/all hello')`)
  assert.deepEqual(plain(r.context.chats), [['A', 'hello'], ['B', 'hello'], ['C', 'hello']])
})

// ── /repeat: repetitions take time instead of machine-gunning ───────────────
test('/repeat spaces its runs with REPEAT_DELAY_MS instead of looping instantly', () => {
  const r = runtime()
  r.timers.clear()
  r.run(`handleCommand('/repeat 3 hello')`)
  // The first run is immediate; the rest are queued as timers, not looped.
  assert.deepEqual(plain(r.context.chats), [['A', 'hello']])
  assert.equal(r.timers.size, 1)
  assert.equal([...r.timers.values()][0].delay, 2000) // REPEAT_DELAY_MS default
  const tick = () => { const t = [...r.timers.keys()][0]; r.timers.delete(t); t.fn() }
  tick()
  assert.deepEqual(plain(r.context.chats), [['A', 'hello'], ['A', 'hello']])
  tick()
  assert.deepEqual(plain(r.context.chats), [['A', 'hello'], ['A', 'hello'], ['A', 'hello']])
  assert.equal(r.timers.size, 0, 'finished after 3 runs')
})

test('/repeat takes an explicit delay per command', () => {
  const r = runtime()
  r.timers.clear()
  r.run(`handleCommand('/repeat 2 500ms hi')`)
  assert.deepEqual(plain(r.context.chats), [['A', 'hi']])
  assert.equal([...r.timers.values()][0].delay, 500)
  const t = [...r.timers.keys()][0]; r.timers.delete(t); t.fn()
  assert.equal(r.timers.size, 0)
  assert.equal(r.context.chats.length, 2)
})

test('/repeat duration mode paces runs and stops at the deadline', () => {
  const r = runtime()
  r.timers.clear()
  // The vm context has its own Date — move its clock per tick so the
  // deadline check is deterministic.
  r.run('__clock = Date.now(); Date.now = () => __clock')
  r.run(`handleCommand('/repeat 2s 500ms x')`)
  assert.deepEqual(plain(r.context.chats), [['A', 'x']])
  const tick = () => { const t = [...r.timers.keys()][0]; r.timers.delete(t); r.run('__clock += 500'); t.fn() }
  tick(); tick(); tick()
  assert.equal(r.context.chats.length, 4, 'runs at 0, 500, 1000 and 1500ms')
  tick()
  assert.equal(r.context.chats.length, 4, 'the 2s deadline stops the repeat')
  assert.equal(r.timers.size, 0)
})

test('/repeat stop cancels the queued runs', () => {
  const r = runtime()
  r.timers.clear()
  r.run(`handleCommand('/repeat 5 hello')`)
  assert.equal(r.timers.size, 1)
  r.run(`handleCommand('/repeat stop')`)
  assert.equal(r.timers.size, 0)
  assert.equal(r.context.chats.length, 1, 'only the immediate first run happened')
})

test('/repeat repeats the previous command, never /repeat itself', () => {
  const r = runtime()
  r.timers.clear()
  // The interfaces record the command in history before handling it — the
  // same order a typed /repeat has, so the naive "last entry" would be
  // /repeat and recurse.
  r.run(`recordHistory('hello there'); recordHistory('/repeat 2'); handleCommand('/repeat 2')`)
  assert.deepEqual(plain(r.context.chats), [['A', 'hello there']])
  const t = [...r.timers.keys()][0]; r.timers.delete(t); t.fn()
  assert.deepEqual(plain(r.context.chats), [['A', 'hello there'], ['A', 'hello there']])
})

// ── /use-book: book → hotbar slot 1 → /use && /use ──────────────────────────
test('/use-book swaps the book into hotbar slot 1, selects it and uses it twice', async () => {
  const r = runtime({ BOOK_USE_DELAY_MS: '0' })
  r.run(`
    __steps = []
    __slots = []
    __slots[10] = { name: 'book', displayName: 'Book', count: 3, slot: 10 }
    __slots[36] = { name: 'diamond', displayName: 'Diamond', count: 2, slot: 36 }
    bots.A.bot.currentWindow = null
    bots.A.bot.inventory = { slots: __slots, inventoryEnd: 45 }
    bots.A.bot.clickWindow = async (slot) => { __steps.push('click ' + slot) }
    bots.A.bot.setQuickBarSlot = (n) => { __steps.push('hotbar ' + n) }
    bots.A.bot.activateItem = () => { __steps.push('use') }
  `)
  const result = plain(await r.run("runBookUseRoutine('A')"))
  assert.equal(result.ran, true)
  // The displaced diamond goes back where the book was.
  assert.deepEqual(plain(r.run('__steps')), ['click 10', 'click 36', 'click 10', 'hotbar 0', 'use', 'use'])
})

test('/use-book with no book present does nothing at all', async () => {
  const r = runtime({ BOOK_USE_DELAY_MS: '0' })
  r.run(`
    __steps = []
    __slots = []
    __slots[36] = { name: 'diamond', displayName: 'Diamond', count: 2, slot: 36 }
    bots.A.bot.currentWindow = null
    bots.A.bot.inventory = { slots: __slots, inventoryEnd: 45 }
    bots.A.bot.clickWindow = async (slot) => { __steps.push('click ' + slot) }
    bots.A.bot.setQuickBarSlot = () => { __steps.push('hotbar') }
    bots.A.bot.activateItem = () => { __steps.push('use') }
  `)
  const result = plain(await r.run("runBookUseRoutine('A')"))
  assert.equal(result.ran, false)
  assert.deepEqual(plain(r.run('__steps')), [], 'no match — no clicks, no use')
})

test('/use-book auto toggles the GUI-triggered mode', () => {
  const r = runtime()
  try {
    r.run("handleCommand('/use-book auto on')")
    assert.equal(r.run("settings.get('BOOK_AUTO')"), true)
    r.run("handleCommand('/use-book auto off')")
    assert.equal(r.run("settings.get('BOOK_AUTO')"), false)
  } finally {
    r.run("settings.reset('BOOK_AUTO')")
  }
})

// ── /copy: the held item, everything about it, unicode included ─────────────
test('/copy reports the held item fully and copies it to the clipboard', () => {
  const r = runtime()
  try {
    r.run("copyTextToClipboard = (text, done) => { __copied = text; done(true) }")
    r.run(`
      bots.A.bot.heldItem = {
        name: 'paper', displayName: 'Paper', type: 332, metadata: 0, count: 1, slot: 36,
        customName: '\u{1D4AE}\u{1D4FC}\u{1D4F9}\u{1D4F9}\u{1D502} \u{1D4FC}\u{1D4FA}',
        enchantments: [{ id: 'unbreaking', level: 3 }],
        nbt: { type: 'compound', value: {} }
      }
    `)
    r.run("handleCommand('/copy')")
    const report = r.run('__copied')
    assert.match(report, /Name: \u{1D4AE}\u{1D4FC}\u{1D4F9}\u{1D4F9}\u{1D502} \u{1D4FC}\u{1D4FA}/u, 'the unicode name survives verbatim')
    assert.match(report, /Registry: paper/)
    assert.match(report, /Enchants: unbreaking 3/)
    assert.match(report, /NBT: /)
    assert.match(channelLogs(r, 'A'), /Copied the full item report/)

    r.run("handleCommand('/copy name')")
    assert.equal(r.run('__copied'), '\u{1D4AE}\u{1D4FC}\u{1D4F9}\u{1D4F9}\u{1D502} \u{1D4FC}\u{1D4FA}', '/copy name copies just the name')
  } finally {
    r.run("bots.A.bot.heldItem = null")
  }
})

// A permanent ban has to actually leave the roster, and the removed list — not a
// live connection — is what decides whether a bot may come back.
test('the removed list gates reconnecting and /unban puts a bot back', () => {
  const r = runtime()
  assert.equal(r.run('removedEntryFor("A")'), null, 'nothing is removed by default')

  // What a permanent ban does, minus the live kick event.
  r.run(`removedBots = removedBotsStore.addRemovedBot(removedBots, { bot: 'A', kind: 'permanent', reason: 'cheating' }, { addedBy: 'ban-detection' }).list`)
  assert.equal(r.run('removedEntryFor("A").bot'), 'A')
  assert.equal(r.run('removedEntryFor("a").bot'), 'A', 'a name from .env may not match the kick text casing')
  assert.equal(r.run('removedEntryFor("B")'), null)

  assert.equal(r.run('dropFromRoster("A")'), true)
  assert.equal(r.run('Object.keys(bots).includes("A")'), false, 'the bot leaves the live roster')
  assert.equal(r.run('activeId'), 'C', 'the active bot moves off the removed one')
  assert.equal(r.run('dropFromRoster("A")'), false, 'dropping it twice is harmless')

  // The commands must survive being called, and /unban must clear both the list
  // and the ban flag (otherwise the data file keeps reporting a ban).
  r.run(`handleCommand('/removed')`)
  r.run(`handleCommand('/unban')`)
  r.run(`handleCommand('/unban ghost')`)
  assert.equal(r.run('removedEntryFor("A").bot'), 'A', 'a bare or unknown /unban changes nothing')

  r.run('dataState.bots.A = { banned: true, banKind: "permanent", banExpiresAt: 0 }')
  r.run(`handleCommand('/unban A')`)
  assert.equal(r.run('removedEntryFor("A")'), null, 'the bot is off the removed list')
  assert.equal(r.run('dataState.bots.A.banned'), false, 'and its ban flag is cleared')

  assert.equal(r.run('PERMANENT_BAN_ACTION'), 'remove', 'a permanent ban defaults to leaving the roster')
})

// The connect gate is removed-bots.json and nothing else. Ban flags in the data
// file are reporting — a flagged bot must keep dialling, or one bad verdict (or
// a stale flag left in data/ from an old session) strands the account forever.
test('only the removed list blocks connecting; data-file ban flags do not', () => {
  const r = runtime()
  r.run(`
    dataState.bots.A = { banned: true, banKind: 'temporary', banExpiresAt: Date.now() + 60000 }
    dataState.bots.B = { banned: true, banKind: 'permanent', banExpiresAt: 0 }
  `)
  assert.equal(r.run('connectBlockReason("A")'), null, 'a live data-file ban flag is not a gate')
  assert.equal(r.run('connectBlockReason("B")'), null, 'not even a permanent-looking one')

  r.timers.clear()
  r.run(`handleCommand('/reconnect')`)
  assert.ok([...r.timers.values()].some(t => t.delay === 1000), 'a data-banned bot is still reconnected on demand')

  r.run(`removedBots = removedBotsStore.addRemovedBot(removedBots, { bot: 'B', kind: 'permanent', reason: 'cheating' }, { addedBy: 'ban-detection' }).list`)
  assert.match(String(r.run('connectBlockReason("B")')), /removed list/, 'the removed list is the gate')
  r.run(`handleCommand('/switch 2')`)
  r.timers.clear()
  r.run(`handleCommand('/reconnect')`)
  assert.equal(r.timers.size, 0, 'a removed bot is never reconnected')
  assert.match(r.run(`bots.B.logs.map(l => l.text).join('|')`), /removed list/)
})

// /unban-all empties the removed list and walks the bots back one at a time —
// every restored bot at once would trip the server's login rate limit.
test('/unban-all restores everyone with a stagger between reconnects', () => {
  const r = runtime({ UNBAN_ALL_STAGGER_MS: '100' })
  r.timers.clear()
  r.run(`removedBots = removedBotsStore.addRemovedBot(removedBots, { bot: 'A', kind: 'permanent', reason: 'cheating' }, { addedBy: 'ban-detection' }).list`)
  r.run(`removedBots = removedBotsStore.addRemovedBot(removedBots, { bot: 'B', kind: 'temporary', reason: 'alt farming' }, { addedBy: 'ban-detection' }).list`)
  r.run(`dataState.bots.A = { banned: true, banKind: 'permanent', banExpiresAt: 0 }`)
  r.run(`createBotInstance = (id) => chats.push([id, 'connect'])`)

  r.run(`handleCommand('/unban-all')`)
  assert.equal(r.run('removedBots.bots.length'), 0, 'the list is emptied')
  assert.equal(r.run('dataState.bots.A.banned'), false, 'and the data-file report flags are cleared too')
  assert.deepEqual([...r.timers.values()].map(t => t.delay).sort((a, b) => a - b), [0, 100], 'one reconnect per bot, UNBAN_ALL_STAGGER_MS apart — never all at once')

  while (r.timers.size) { const t = [...r.timers.keys()][0]; r.timers.delete(t); t.fn() }
  assert.deepEqual(plain(r.context.chats), [['A', 'connect'], ['B', 'connect']], 'both bots come back, each on its own timer')

  // An empty list must not schedule anything.
  r.timers.clear()
  r.run(`handleCommand('/unban-all')`)
  assert.equal(r.timers.size, 0, 'nothing to restore means nothing to reconnect')
})

// The chat-game default pace is a gameplay decision: too fast looks scripted.
test('chat games stay disabled and preserve the user-configured server pace', () => {
  const r = runtime()
  assert.equal(r.run("settings.get('CHAT_GAME_AUTO')"), false)
  assert.equal(r.run("settings.get('CHAT_GAME_GUESS_MS')"), 1150)
  assert.equal(r.run("settings.get('CHAT_GAME_MAX_BOTS')"), 10)
  r.run(`feedChatGameLine('Hint: 1-15')`)
  assert.deepEqual(plain(r.context.chats), [], 'disabled game never replies')
  const tuned = runtime({ CHAT_GAME_GUESS_MS: '50' })
  assert.equal(tuned.run("settings.get('CHAT_GAME_GUESS_MS')"), 50, 'and stays overridable')
})

// The dashboard's "⟳ tor" button: per-port results, failures never throw.
// --no-reconnect / "reconnect": false keep the sweep reporting-only here —
// the reconnect half of a rotation has its own test below.
test('/api/tor/newnym and /tor-newnym report every control port', async () => {
  const r = runtime({ TOR_CONTROL_PORTS: '59997' })
  const cookie = await r.login()
  const res = await r.request('/api/tor/newnym', JSON.stringify({ reconnect: false }), cookie, 'POST')
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false, 'a dead control port is a reported failure, not a crash')
  assert.equal(body.results[0].port, 59997)
  assert.ok(body.results[0].error, 'and it says why')
  assert.equal(body.reconnected, 0, 'reporting-only never touches a connection')

  r.timers.clear()
  const result = await r.run(`handleCommand('/tor-newnym --no-reconnect')`)
  assert.equal(result.ok, false)
  assert.equal(result.results.length, 1, 'the console command runs the same sweep')
  assert.equal(r.timers.size, 0, 'and --no-reconnect schedules nothing')

  const empty = runtime()
  const bare = await empty.run(`handleCommand('/tor-newnym')`)
  assert.equal(bare.ok, false)
  assert.equal(bare.results.length, 0, 'with no local Tor there is nothing to signal — reported, not guessed at')
})

// A rotation only takes effect if the scoped bots actually reconnect — SIGNAL
// NEWNYM alone leaves every live connection on its old circuit and exit IP.
// The scope is a proxy group number, a bot name (its group), 'default' for the
// ungrouped remainder, or 'all'; an unknown scope is an error, never a silent
// rotate-everything.
test('/tor-newnym rotates one proxy group and reconnects only its bots after a successful signal', async () => {
  const r = runtime({
    TOR_CONTROL_PORTS: '59997',
    TOR_ROTATE_DELAY_MS: '1000',
    PROXY_GROUP_1_BOTS: 'A,B',
    PROXY_GROUP_1_HOST: 'localhost',
    PROXY_GROUP_1_PORT: '9150',
    PROXY_GROUP_2_BOTS: 'C',
    PROXY_GROUP_2_HOST: 'localhost',
    PROXY_GROUP_2_PORT: '9050'
  })
  r.timers.clear()

  // Deterministic successful control response: a dead port must NOT churn bots.
  r.run(`requestTorCircuits = async () => ({ ok: true, results: [{ port: 59997, ok: true }] })`)
  const two = await r.run(`handleCommand('/tor-newnym 2')`)
  assert.equal(two.scope, 2)
  assert.equal(two.label, 'proxy group 2')
  assert.equal(two.reconnected, 1, 'only group 2\'s bot is reconnected')
  assert.equal(r.timers.size, 1, 'one staggered reconnect is scheduled')

  r.timers.clear()
  const named = await r.run(`handleCommand('/tor-newnym A')`)
  assert.equal(named.scope, 1, 'a bot name resolves to its group')
  assert.equal(named.reconnected, 2, 'the whole group rotates, not just the named bot')

  r.timers.clear()
  const def = await r.run(`handleCommand('/tor-newnym default')`)
  assert.equal(def.scope, 'default')
  assert.equal(def.reconnected, 0, 'no ungrouped bots exist in this runtime')

  const bad = await r.run(`handleCommand('/tor-newnym 9')`)
  assert.equal(bad.ok, false)
  assert.match(bad.error, /no proxy group 9/)
  assert.equal(r.timers.size, 0, 'a bad scope schedules nothing')
})

// The sweep only tidies reporting flags — it must never yank a connection
// around (it used to force-reconnect, which could double up a live bot).
test('the ban sweep clears lapsed flags without touching connections', () => {
  const r = runtime()
  r.timers.clear()
  r.run(`
    dataState.bots.A = { banned: true, banKind: 'temporary', banExpiresAt: Date.now() - 1000 }
    dataState.bots.B = { banned: true, banKind: 'temporary', banExpiresAt: Date.now() + 60000 }
    dataState.bots.C = { banned: true, banKind: 'permanent', banExpiresAt: 0 }
  `)
  r.run('releaseExpiredBans()')
  assert.equal(r.run('dataState.bots.A.banned'), false, 'an elapsed flag is cleared')
  assert.equal(r.run('dataState.bots.B.banned'), true, 'a live one is kept')
  assert.equal(r.run('dataState.bots.C.banned'), true, 'a permanent one is kept')
  assert.equal(r.timers.size, 0, 'clearing report flags must never force a reconnect')
})

// A "guess the number" chat game is answered by the fleet: every number in the
// range exactly once, from more than one bot, as fast as the timer allows.
test('chat game prompts are covered by the fleet in random order', () => {
  const r = runtime({ CHAT_GAME_AUTO: 'true' })
  r.timers.clear()
  r.run(`feedChatGameLine('A chat event has started! You have 20 seconds to guess the number')`)
  assert.equal(r.run('chatGame.running'), false, 'a countdown alone starts nothing')
  r.run(`feedChatGameLine('\u2726 Hint: 1-15 | Reward: $2,500')`)
  assert.equal(r.run('chatGame.running'), true)
  let guard = 1000
  while (r.timers.size && guard--) { const t = [...r.timers.keys()][0]; r.timers.delete(t); t.fn() }
  const chats = plain(r.context.chats)
  const values = chats.map(([, msg]) => Number(msg)).filter(Number.isFinite)
  assert.deepEqual([...values].sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i + 1), 'every number 1-15, exactly once')
  assert.equal(new Set(chats.map(([id]) => id)).size > 1, true, 'from more than one bot')
  assert.equal(r.run('chatGame.running'), false, 'the round ends when the range is covered')

  // A reveal mid-round stops it after the guess already in flight.
  r.timers.clear()
  r.context.chats.length = 0
  r.run(`feedChatGameLine('Hint: 1-100')`)
  r.run(`feedChatGameLine('Steve guessed the number!')`)
  while (r.timers.size) { const t = [...r.timers.keys()][0]; r.timers.delete(t); t.fn() }
  assert.equal(r.context.chats.length, 1, 'only the immediate first guess is sent')
  assert.equal(r.run('chatGame.running'), false)
})

// An equation round has ONE exact answer, so exactly ONE randomly chosen bot
// says it — computed, never guessed, and never twice.
test('an equation chat game is answered exactly once by one bot', () => {
  const r = runtime({ CHAT_GAME_AUTO: 'true' })
  r.timers.clear()
  r.run(`feedChatGameLine('Solve: 3x+5=20 | Reward: $2,500')`)
  const chats = plain(r.context.chats)
  assert.equal(chats.length, 1, 'exactly one bot answers')
  assert.equal(chats[0][1], '5', 'the computed value of x, just the number')
  r.run(`feedChatGameLine('Solve: 3x+5=20 | Reward: $2,500')`)
  assert.equal(plain(r.context.chats).length, 1, 'a repeated banner is not answered twice')
  r.run(`feedChatGameLine('I think x = 5 lol')`)
  assert.equal(plain(r.context.chats).length, 1, 'player chatter never triggers an answer')
})

// bot-scripts: one command per line, "*<fragment>" targets bots by name.
test('/run-script runs lines in order with * targeting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-scripts-'))
  fs.writeFileSync(path.join(dir, 'demo.txt'), '# demo\nhello\n*B one\n* two\n')
  const r = runtime({ BOT_SCRIPTS_DIR: dir })
  r.timers.clear()
  await r.run(`handleCommand('/run-script demo')`)
  assert.deepEqual(plain(r.context.chats), [
    ['A', 'hello'], ['B', 'one'], ['A', 'two'], ['B', 'two'], ['C', 'two']
  ], 'bare lines run on the invoker, *name on matching bots, * on everyone')
  const before = plain(r.context.chats).length
  await r.run(`handleCommand('/run-script ../demo')`)
  await r.run(`handleCommand('/run-script missing')`)
  assert.equal(plain(r.context.chats).length, before, 'bad or missing scripts send nothing')
  r.run(`handleCommand('/scripts')`)
  assert.match(channelLogs(r, 'A'), /Scripts in/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('/ege stops politely when the bot is not spawned', () => {
  const r = runtime()
  r.run(`bots.A.bot.entity = null`)
  r.run(`handleCommand('/ege')`)
  assert.match(channelLogs(r, 'A'), /not currently spawned/)
  assert.ok(!r.run('bots.A.inAppleRoutine') && !r.run('bots.A.appleRoutineRunning'), 'and no routine flag is left set')
})


test('item name helpers prefer anvil custom names and expose the alternative name', () => {
  const r = runtime()
  const out = r.run(`(() => {
    const named = { name: 'netherite_sword', displayName: 'Netherite Sword', customName: '{"text":"Sword"}' }
    const componentName = { name: 'diamond_pickaxe', displayName: 'Diamond Pickaxe', customName: { text: 'My Pick', extra: ['!'] } }
    const plainName = { name: 'diamond_sword', displayName: 'Diamond Sword', customName: 'Sword' }
    const unrenamed = { name: 'netherite_sword', displayName: 'Netherite Sword', customName: null }
    const noCustom = { name: 'diamond', displayName: 'Diamond' }
    // 1.20.5+ sends custom_name as an NBT compound text component; prismarine-item
    // surfaces it through item.customName in this exact shape.
    const nbtCompound = { name: 'netherite_sword', displayName: 'Netherite Sword', customName: { type: 'compound', name: '', value: { text: { type: 'string', value: 'Sword' }, italic: { type: 'byte', value: 0 } } } }
    const nbtString = { name: 'diamond_sword', displayName: 'Diamond Sword', customName: { type: 'string', value: '{"text":"Blade"}' } }
    const legacyNbt = { name: 'netherite_sword', displayName: 'Netherite Sword', customName: null, nbt: { type: 'compound', value: { display: { type: 'compound', value: { Name: { type: 'string', value: '{"text":"Legacy"}' } } } } } }
    return [
      itemDisplayName(named), itemAltName(named, itemDisplayName(named)),
      itemDisplayName(componentName), itemAltName(componentName, itemDisplayName(componentName)),
      itemDisplayName(plainName), itemAltName(plainName, itemDisplayName(plainName)),
      itemDisplayName(unrenamed), itemAltName(unrenamed, itemDisplayName(unrenamed)),
      itemDisplayName(noCustom), itemAltName(noCustom, itemDisplayName(noCustom)),
      itemDisplayName(nbtCompound), itemAltName(nbtCompound, itemDisplayName(nbtCompound)),
      itemDisplayName(nbtString), itemAltName(nbtString, itemDisplayName(nbtString)),
      itemDisplayName(legacyNbt), itemAltName(legacyNbt, itemDisplayName(legacyNbt))
    ]
  })()`)
  assert.deepEqual(plain(out), [
    'Sword', 'netherite_sword',
    'My Pick!', 'diamond_pickaxe',
    'Sword', 'diamond_sword',
    'Netherite Sword', 'netherite_sword',
    'Diamond', null,
    'Sword', 'netherite_sword',
    'Blade', 'diamond_sword',
    'Legacy', 'netherite_sword'
  ])
})

test('/find matches custom, display, and registry names across all bots', () => {
  const r = runtime()
  r.run(`
    bots.A.bot.inventory = { items: () => [
      { type: 1, slot: 12, count: 3, name: 'netherite_sword', displayName: 'Netherite Sword', customName: { type: 'string', value: 'Sword' } },
      { type: 2, slot: 8, count: 1, name: 'diamond', displayName: 'Diamond', customName: null }
    ] }
    bots.B.bot.inventory = { items: () => [
      { type: 3, slot: 0, count: 5, name: 'red_shulker_box', displayName: 'Red Shulker Box', customName: null }
    ] }
    bots.C.bot.inventory = { items: () => [] }
  `)
  r.run(`handleCommand('/find sword')`)
  let logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /\[A\]/)
  assert.match(logText, /3x Sword \(netherite_sword\) — inv slot 12/)
  assert.equal(r.run('chats.length'), 0)
  r.run(`handleCommand('/find shulker')`)
  logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /5x Red Shulker Box \(red_shulker_box\) — inv slot 0/)
  // No match anywhere
  r.run(`handleCommand('/find nonexistent-item-xyz')`)
  logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /No bot has an item matching/)
  // Usage
  r.run(`handleCommand('/find')`)
  logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /Usage: \/find/)
})

test('/find also scans the open window and skips offline bots', () => {
  const r = runtime()
  r.run(`
    bots.A.bot.inventory = { items: () => [] }
    bots.A.bot.currentWindow = { slots: { 5: { type: 4, slot: 5, count: 2, name: 'diamond_sword', displayName: 'Diamond Sword', customName: null } } }
    bots.B.bot.entity = null
  `)
  r.run(`handleCommand('/find diamond')`)
  const logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /2x Diamond Sword \(diamond_sword\) — window slot 5/)
  assert.match(logText, /\[B\] offline — skipped/)
})

test('/cron add lists runs and manages jobs', () => {
  const r = runtime()
  r.run(`handleCommand('/cron add "*/5 * * * *" /status')`)
  assert.equal(r.run('cronManager.list().length'), 1)
  assert.equal(r.run('cronManager.list()[0].schedule'), '*/5 * * * *')
  assert.equal(r.run('cronManager.list()[0].command'), '/status')
  // Bare /cron lists it
  r.run(`handleCommand('/cron')`)
  let logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /Cron jobs/)
  assert.match(logText, /\[[^\]]*1[^\]]*\]/)
  // /cron run fires it through the /all-style dispatcher (local command → per-bot, no chat)
  r.run(`handleCommand('/cron run 1')`)
  assert.equal(r.run('chats.length'), 0)
  logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /Status for A/)
  assert.equal(r.run('cronManager.list()[0].runs'), 1)
  // Disable, list state, remove
  r.run(`handleCommand('/cron off 1')`)
  assert.equal(r.run('cronManager.list()[0].enabled'), false)
  r.run(`handleCommand('/cron on 1')`)
  assert.equal(r.run('cronManager.list()[0].enabled'), true)
  r.run(`handleCommand('/cron rm 1')`)
  assert.equal(r.run('cronManager.list().length'), 0)
  r.run(`handleCommand('/cron rm 1')`)
  logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /No cron job with id 1/)
})

test('/cron supports @every and raw-chat broadcast commands', () => {
  const r = runtime()
  r.run(`handleCommand('/cron add @every 60 hello everyone')`)
  assert.equal(r.run('cronManager.list()[0].schedule'), '@every 60')
  assert.equal(r.run('cronManager.list()[0].command'), 'hello everyone')
  r.run(`handleCommand('/cron run 1')`)
  assert.deepEqual(plain(r.context.chats), [['A', 'hello everyone'], ['B', 'hello everyone'], ['C', 'hello everyone']])
  // Bad schedule / bad subcommand produce warnings, not crashes
  r.run(`handleCommand('/cron add bogus /status')`)
  r.run(`handleCommand('/cron wat')`)
})

test('CRON_JOB_<N> env entries load at startup', () => {
  const r = runtime({ CRON_JOB_1: '@every 60|/status', CRON_JOB_2: '0 */2 * * *|/crates-all' })
  assert.equal(r.run('cronManager.list().length'), 2)
  assert.equal(r.run('cronManager.list()[0].command'), '/status')
  assert.equal(r.run('cronManager.list()[1].schedule'), '0 */2 * * *')
})

test('CRON_JOB_<N> env entries with quotes or errors load at startup without TDZ crash', () => {
  const r = runtime({
    CRON_JOB_1: '"0 4 * * *|/crates-all"',
    CRON_JOB_2: "'@every 60|/status'",
    CRON_JOB_3: 'broken schedule|/status'
  })
  assert.equal(r.run('cronManager.list().length'), 2)
  assert.equal(r.run('cronManager.list()[0].schedule'), '0 4 * * *')
  assert.equal(r.run('cronManager.list()[0].command'), '/crates-all')
  assert.equal(r.run('cronManager.list()[1].schedule'), '@every 60')
})

test('/dump-spawners is recognized as a local command', () => {
  const r = runtime()
  assert.equal(r.run("LOCAL_COMMANDS.includes('/dump-spawners')"), true)
})

test('/all reuses the shared dispatcher (local args preserved, chat broadcast)', () => {
  const r = runtime()
  r.run(`
    for (const id of ['A', 'B', 'C']) {
      bots[id].bot.entity = { position: { x: 0, y: 0, z: 0 } }
      bots[id].host = 'test-host'; bots[id].port = 1; bots[id].version = '1'; bots[id].spawnTime = Date.now()
    }
  `)
  r.run(`handleCommand('/all /status')`)
  let logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /Ran locally on 3 bots/)
  assert.equal(r.run('chats.length'), 0)
  r.run(`handleCommand('/all !hello')`)
  assert.deepEqual(plain(r.context.chats), [['A', 'hello'], ['B', 'hello'], ['C', 'hello']])
})

test('webClientUrl builds connect-screen prefills for the /play tab', () => {
  const r = runtime()
  assert.equal(r.run('MC_WEB_ENABLED'), true)
  assert.equal(r.run('MC_WEB_CLIENT_URL'), '')
  assert.equal(r.run('MC_WEB_CLIENT_PORT'), 8090)
  assert.equal(r.run('MC_WEB_VERSION'), '1.21.4')
  assert.equal(
    r.run(`webClientUrl({ base: 'http://localhost:8090/', ip: 'play.example.com:25565', version: '1.21.4', username: 'Steve', proxy: 'wss://mc.example.com' })`),
    'http://localhost:8090/?ip=play.example.com%3A25565&version=1.21.4&username=Steve&proxy=wss%3A%2F%2Fmc.example.com'
  )
  assert.equal(r.run(`webClientUrl({ ip: 'a.b:1' })`), 'http://localhost/?ip=a.b%3A1')
  assert.equal(r.run(`webClientUrl({})`), 'http://localhost/')
  assert.equal(r.run(`webClientUrl({ base: 'https://client.example.com/app/', username: 'X' })`), 'https://client.example.com/app/?username=X')
})

test('/play requires auth', async () => {
  const r = runtime()
  const res = await r.request('/play', '', '', 'GET')
  assert.equal(res.status, 303)
  assert.equal(res.headers.Location, '/login')
})

test('/play serves the self-hosted minecraft web client with prefills', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcweb-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>fake client</html>')
  try {
    const r = runtime({ MC_WEB_SERVER: 'play.example.com:25565', MC_WEB_VERSION: '1.21.4', MC_WEB_USERNAME: 'Steve', MC_WEB_PROXY: 'wss://mc.example.com', MC_WEB_CLIENT_DIR: dir })
    const cookie = await r.login()
    const res = await r.request('/play', '', cookie, 'GET')
    assert.equal(res.status, 200)
    assert.match(res.body, /<iframe/)
    assert.match(res.body, /http:\/\/localhost:[0-9]+\/\?ip=play\.example\.com%3A25565&amp;version=1\.21\.4&amp;username=Steve&amp;proxy=wss%3A%2F%2Fmc\.example\.com/)
    assert.doesNotMatch(res.body, /mcraft\.fun/)
    // Page heartbeats while open and beacons a stop on exit.
    assert.match(res.body, /play-ping/)
    assert.match(res.body, /sendBeacon\('\/play-stop'\)/)
    const h = await r.run('webHandle.webClientReady')
    assert.equal(h.started, true)
    const dash = await r.request('/', '', cookie, 'GET')
    assert.match(dash.body.toString(), /id="playbtn"/)
    h.server.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('/play-stop fully stops the client server and /play restarts it on the same port', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcweb-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>fake client</html>')
  try {
    const r = runtime({ MC_WEB_CLIENT_DIR: dir })
    const cookie = await r.login()
    await r.request('/play', '', cookie, 'GET')
    const h1 = await r.run('webHandle.webClientReady')
    assert.equal(h1.started, true)
    const port1 = h1.port
    const res = await r.request('/play-stop', '', cookie, 'POST')
    assert.equal(res.status, 204)
    const after = await r.run('webHandle.webClientReady')
    assert.equal(after, null)
    assert.equal((await r.run('webHandle.webClient')).started, false)
    // Port is freed → the next /play binds the same port again.
    await r.request('/play', '', cookie, 'GET')
    const h3 = await r.run('webHandle.webClientReady')
    assert.equal(h3.started, true)
    assert.equal(h3.port, port1)
    h3.server.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('/play shows the build-not-found page when the client build is missing', async () => {
  // Point MC_WEB_CLIENT_DIR at an EMPTY dir instead of relying on the real
  // web-client/dist being unbuilt: once a developer (or CI) has run the build,
  // the default dir contains a client — this test would fail AND leave a real
  // server bound on the default port, which keeps the runner alive forever.
  const r = runtime({ MC_WEB_AUTO_BUILD: 'false', MC_WEB_CLIENT_DIR: emptyDistDir() })
  const cookie = await r.login()
  const res = await r.request('/play', '', cookie, 'GET')
  assert.equal(res.status, 200)
  assert.match(res.body, /build not found/)
  assert.match(res.body, /npm run web-client:build/)
  assert.doesNotMatch(res.body, /<iframe/)
  assert.doesNotMatch(res.body, /mcraft\.fun/)
  // webClientReady is deliberately NOT cached for a missing build (the build
  // can finish later, so a later request has to re-check) — assert on the live
  // state instead, which is what "no client server started" really means.
  assert.equal((await r.run('webHandle.webClient')).started, false)
  assert.equal(await r.run('webHandle.webClientReady'), null)
})

test('/play and the PLAY button are disabled when MC_WEB_ENABLED=false', async () => {
  const r = runtime({ MC_WEB_ENABLED: 'false' })
  const cookie = await r.login()
  const res = await r.request('/play', '', cookie, 'GET')
  assert.equal(res.status, 404)
  const dash = await r.request('/', '', cookie, 'GET')
  assert.doesNotMatch(dash.body.toString(), /id="playbtn"/)
})

test('/shardshop-loop [slot] argument handling', async () => {
  const r = runtime()
  // Mock bot entity for bot A so commands can run
  r.run(`
    bots.A.bot.entity = { position: { x: 0, y: 0, z: 0 } }
    bots.A.bot.on = () => {}
    bots.A.bot.removeListener = () => {}
  `)

  // Valid slot via handleCommand
  r.run(`handleCommand('/shardshop-loop 13')`)
  assert.equal(r.run('bots.A.shardshopSlot'), 13)
  assert.equal(r.run('bots.A.shardshopLoopRunning'), true)

  // Clean up loop state for next test
  r.run(`bots.A.shardshopSlot = null; bots.A.shardshopLoopRunning = false`)

  // Invalid slot (out of 0..53 bounds) should warn and not start loop
  r.run(`handleCommand('/shardshop-loop 99')`)
  assert.equal(r.run('bots.A.shardshopLoopRunning'), false)
  assert.equal(r.run('bots.A.shardshopSlot'), null)

  // Invalid non-integer slot
  r.run(`handleCommand('/shardshop-loop abc')`)
  assert.equal(r.run('bots.A.shardshopLoopRunning'), false)

  // /all /shardshop-loop <slot> dispatches to all bots with slot preserved
  r.run(`
    bots.B.bot.entity = { position: { x: 0, y: 0, z: 0 } }; bots.B.bot.on = () => {}; bots.B.bot.removeListener = () => {}
    bots.C.bot.entity = { position: { x: 0, y: 0, z: 0 } }; bots.C.bot.on = () => {}; bots.C.bot.removeListener = () => {}
    handleCommand('/all /shardshop-loop 20')
  `)
  assert.equal(r.run('bots.A.shardshopSlot'), 20)
  assert.equal(r.run('bots.B.shardshopSlot'), 20)
  assert.equal(r.run('bots.C.shardshopSlot'), 20)
})

test('multiple concurrent /all-slow tasks and cancellation', () => {
  const r = runtime({ ALL_SLOW_DELAY_MS: '25' })
  r.timers.clear()

  // Start two concurrent /all-slow broadcasts
  r.run(`handleCommand('/all-slow !first')`)
  r.run(`handleCommand('/all-slow !second')`)

  assert.equal(r.run('slowBroadcast.running'), true)
  assert.equal(r.run('slowBroadcast.list().length'), 2)
  assert.deepEqual(plain(r.context.chats), [['A', 'first'], ['A', 'second']])

  // Cancel task 1 specifically
  r.run(`handleCommand('/all-slow-cancel 1')`)
  assert.equal(r.run('slowBroadcast.list().length'), 1)
  assert.equal(r.run('slowBroadcast.list()[0].id'), 2)

  // Advance timer for remaining task
  const tick = () => { const t = [...r.timers.keys()][0]; if (t) { r.timers.delete(t); t.fn() } }
  tick()
  assert.deepEqual(plain(r.context.chats.slice(2)), [['B', 'second']])

  // Cancel all remaining tasks
  r.run(`handleCommand('/all-slow-cancel')`)
  assert.equal(r.run('slowBroadcast.running'), false)
  assert.equal(r.run('slowBroadcast.list().length'), 0)
})

test('tpaAndDump does nothing when the inventory is empty', async () => {
  const r = runtime({ WARP_COMMAND: '/warp afk' })
  r.timers.clear()
  r.run(`
    bots.A.bot.entity = { position: { x: 0, y: 0, z: 0, clone: () => ({ x: 0, y: 0, z: 0, distanceTo: () => 0 }) } }
    bots.A.bot.on = (ev, fn) => {}
    bots.A.bot.removeListener = () => {}
    bots.A.bot.registry = { blocksByName: { chest: { id: 54 }, trapped_chest: { id: 146 } } }
    bots.A.bot.findBlocks = () => []
    bots.A.bot.inventory = { items: () => [] }
    dumpPromise = tpaAndDump(bots.A.bot, 'A')
  `)
  await r.run('dumpPromise')
  assert.equal(r.run('bots.A.inDumpRoutine'), false)
  assert.deepEqual(plain(r.context.chats), [])
})

test('handleCommand routes chained commands with &&, ;, sleep, and escaping', async () => {
  const r = runtime()
  r.timers.clear()
  r.run(`
    bots.A.bot.entity = { position: { x: 0, y: 0, z: 0 } }
    bots.A.bot.inventory = { items: () => [] }
    bots.A.logs = []
  `)

  // Chained with escaping: /chat hello \&\& world sends literal &&
  await r.run(`handleCommand('/chat hello \\\\&& world')`)
  assert.deepEqual(plain(r.context.chats), [
    ['A', 'hello && world']
  ])

  // Chained sequential && and ;
  await r.run(`handleCommand('/chat step1 ; /chat step2 && /chat step3')`)
  assert.deepEqual(plain(r.context.chats), [
    ['A', 'hello && world'],
    ['A', 'step1'],
    ['A', 'step2'],
    ['A', 'step3']
  ])
})

// ── /play outside Docker ──────────────────────────────────────────────────────
// The Dockerfile bakes web-client/dist into the image, so containers always have
// the client; a plain `npm run start` has to build it. These pin the page each
// state renders, and that turning auto-build off never spawns one.
const wcModule = require('../web-client')
function emptyDistDir () {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'play-dist-')), 'dist')
}

async function waitForBuild () {
  for (let i = 0; i < 200 && wcModule.buildState().running; i++) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(wcModule.buildState().running, false, 'build should have finished')
  return wcModule.buildState()
}

test('MC_WEB_AUTO_BUILD still defaults on for real installs', () => {
  // The test harness forces it off (see runtime); the app's own default is on,
  // which is what makes /play work from a plain `npm run start`.
  assert.equal(runtime({ MC_WEB_AUTO_BUILD: undefined }).run('MC_WEB_AUTO_BUILD'), true)
  assert.equal(runtime({ MC_WEB_AUTO_BUILD: 'true' }).run('MC_WEB_AUTO_BUILD'), true)
  for (const flag of ['false', '0', 'no', 'OFF']) {
    assert.equal(runtime({ MC_WEB_AUTO_BUILD: flag }).run('MC_WEB_AUTO_BUILD'), false)
  }
})

test('/play says the build is missing and spawns nothing when auto-build is off', async () => {
  const r = runtime({ MC_WEB_AUTO_BUILD: 'false', MC_WEB_CLIENT_DIR: emptyDistDir() })
  r.timers.clear()
  const cookie = await r.login()
  const res = await r.request('/play', '', cookie, 'GET')
  assert.equal(res.status, 200)
  assert.match(res.body, /build not found/)
  assert.match(res.body, /npm run web-client:build/)
  assert.equal(wcModule.buildState().running, false, 'auto-build=false must not start a build')
})

test('/play shows live progress while the client build runs, then the failure', async () => {
  const dist = emptyDistDir()
  // A build that produces nothing: exits 0 but leaves no index.html.
  wcModule.startBuild({ dir: dist, command: 'sleep 1' })
  assert.equal(wcModule.buildState().running, true)

  const r = runtime({ MC_WEB_AUTO_BUILD: 'false', MC_WEB_CLIENT_DIR: dist })
  r.timers.clear()
  const cookie = await r.login()
  const building = await r.request('/play', '', cookie, 'GET')
  assert.equal(building.status, 200)
  assert.match(building.body, /building…/)
  // Self-refreshing, so the tab becomes the client once the build lands.
  assert.match(building.body, /http-equiv="refresh"/)

  const finished = await waitForBuild()
  assert.equal(finished.ok, false)
  const failed = await r.request('/play', '', cookie, 'GET')
  assert.equal(failed.status, 200)
  assert.match(failed.body, /build failed/)
  // The failure page must point at both ways forward.
  assert.match(failed.body, /npm run web-client:build/)
  assert.match(failed.body, /MC_WEB_AUTO_BUILD=false/)
})

// A stand-in for an HTTP CONNECT proxy: records the request the bot sent, then
// answers with the status the test asks for.
function fakeHttpProxy(status = 200) {
  const net = require('node:net')
  const requests = []
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buf = ''
    socket.on('data', chunk => {
      buf += chunk.toString('latin1')
      if (!buf.includes('\r\n\r\n')) return
      requests.push(buf)
      socket.write(status === 200
        ? 'HTTP/1.1 200 Connection established\r\n\r\n'
        : `HTTP/1.1 ${status} Proxy Authentication Required\r\n\r\n`)
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      requests,
      port: server.address().port,
      // A successful CONNECT leaves the tunnelled socket open by design, so
      // closing the listener alone would keep the test runner's event loop alive
      // (and the suite would never exit).
      close() { for (const s of sockets) s.destroy(); sockets.clear(); server.close() }
    }))
  })
}

// Drives the real makeProxyConnect closure against a real socket and returns the
// events the fake mineflayer client saw.
async function driveProxy(r, proxy, target = 'mc.example.com') {
  const events = []
  r.context.__client = { socket: null, setSocket(s) { this.socket = s }, emit(...args) { events.push(args) } }
  r.run(`__connect = makeProxyConnect(${JSON.stringify(target)}, 25565, () => {}, 'A')`)
  r.run('__connect(__client)')
  const start = Date.now()
  while (!events.length && Date.now() - start < 4000) await new Promise(res => setTimeout(res, 10))
  // Close the bot's end of the tunnel too, or the socket outlives the test.
  r.run('__client.socket && __client.socket.destroy()')
  return events
}

test('a per-group HTTP proxy password reaches the CONNECT request', async () => {
  const proxy = await fakeHttpProxy()
  try {
    const r = runtime({
      PROXY_GROUP_1_BOTS: 'A',
      PROXY_GROUP_1_HOST: '127.0.0.1',
      PROXY_GROUP_1_PORT: String(proxy.port),
      PROXY_GROUP_1_TYPE: 'http',
      PROXY_GROUP_1_USER: 'alice',
      PROXY_GROUP_1_PASS: 'group-one-secret'
    })
    const events = await driveProxy(r, proxy)
    assert.equal(events[0][0], 'connect', `expected a tunnel, got ${JSON.stringify(events[0])}`)
    assert.equal(proxy.requests.length, 1)
    const expected = 'Basic ' + Buffer.from('alice:group-one-secret').toString('base64')
    assert.ok(proxy.requests[0].includes(`Proxy-Authorization: ${expected}\r\n`), proxy.requests[0])
  } finally { proxy.close() }
})

test('different proxy groups send their own passwords, and a group without one inherits nothing', async () => {
  const authed = await fakeHttpProxy()
  const bare = await fakeHttpProxy()
  try {
    const shared = {
      PROXY_USER: 'global', PROXY_PASS: 'global-secret'
    }
    // Group 1 has its own password; group 2 has none and must NOT fall back to the
    // global one — that would hand the global password to a different proxy.
    const withAuth = runtime({
      ...shared, PROXY_HOST: '127.0.0.1', PROXY_PORT: String(authed.port), PROXY_TYPE: 'http',
      PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: '127.0.0.1', PROXY_GROUP_1_PORT: String(authed.port), PROXY_GROUP_1_TYPE: 'http',
      PROXY_GROUP_1_USER: 'alice', PROXY_GROUP_1_PASS: 'group-one-secret'
    })
    await driveProxy(withAuth, authed)
    assert.ok(authed.requests[0].includes('Proxy-Authorization'))

    const noAuth = runtime({
      ...shared, PROXY_HOST: '127.0.0.1', PROXY_PORT: String(bare.port), PROXY_TYPE: 'http',
      PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: '127.0.0.1', PROXY_GROUP_1_PORT: String(bare.port), PROXY_GROUP_1_TYPE: 'http'
    })
    await driveProxy(noAuth, bare)
    assert.doesNotMatch(bare.requests[0], /Proxy-Authorization/)
    assert.ok(!bare.requests[0].includes('global-secret'))
  } finally { authed.close(); bare.close() }
})

test('a 407 from the proxy names the exact env vars that need credentials', async () => {
  const proxy = await fakeHttpProxy(407)
  try {
    const r = runtime({
      PROXY_GROUP_1_BOTS: 'A',
      PROXY_GROUP_1_HOST: '127.0.0.1',
      PROXY_GROUP_1_PORT: String(proxy.port),
      PROXY_GROUP_1_TYPE: 'http'
    })
    const events = await driveProxy(r, proxy)
    assert.equal(events[0][0], 'error')
    assert.match(String(events[0][1].message), /requires a username and password/)
    assert.match(String(events[0][1].message), /PROXY_GROUP_1_USER \/ _PASS/)
  } finally { proxy.close() }
})

test('/proxy lists each group with its own auth source, without ever printing a password', () => {
  const r = runtime({
    PROXY_HOST: '9.9.9.9', PROXY_PORT: '1080', PROXY_TYPE: 'socks5',
    PROXY_USER: 'globaluser', PROXY_PASS: 'global-secret',
    PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_USER: 'alice', PROXY_GROUP_1_PASS: 'group-one-secret',
    PROXY_GROUP_2_BOTS: 'B', PROXY_GROUP_2_HOST: '5.6.7.8', PROXY_GROUP_2_TYPE: 'http'
  })
  r.timers.clear()
  r.context.__lines = []
  r.run('subscribeLog((id, line) => __lines.push(String(line)))')
  r.run(`handleCommand('/proxy')`)
  const out = r.context.__lines.join('\n')

  // Each group's credentials are named by variable, so the fix for a 407 is visible here.
  assert.match(out, /\[1\] A → SOCKS5 \*\*\*@1\.2\.3\.4:1080 · proxy auth: PROXY_GROUP_1_USER\/_PASS/)
  // Group 2 has none, and must say so rather than implying it borrows the global pair.
  assert.match(out, /\[2\] B → HTTP 5\.6\.7\.8:1080 · proxy auth: none/)
  assert.match(out, /SOCKS5 \*\*\*@9\.9\.9\.9:1080 \(authenticated\)/)
  assert.ok(out.includes('never shared with a group'))
  assert.ok(!out.includes('group-one-secret'), 'group password leaked into /proxy output')
  assert.ok(!out.includes('global-secret'), 'global password leaked into /proxy output')
  assert.doesNotMatch(out, /alice|globaluser/)
})

test('/status reports which variable supplies the login password, per bot', () => {
  const r = runtime({
    LOGIN_PASSWORD: 'global-pw',
    PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_LOGIN_PASSWORD: 'group-pw'
  })
  r.timers.clear()
  r.context.__lines = []
  r.run('subscribeLog((id, line) => __lines.push(String(line)))')

  r.run(`bots.A.bot.entity = { position: { x: 1, y: 2, z: 3 } }`)
  r.run(`bots.B.bot.entity = { position: { x: 4, y: 5, z: 6 } }`)

  r.run(`handleCommand('/switch A'); handleCommand('/status')`)
  r.run(`handleCommand('/switch B'); handleCommand('/status')`)
  const out = r.context.__lines.join('\n')

  // Bot A is in group 1, so it reports the group's password variable…
  assert.match(out, /Login password: from PROXY_GROUP_1_LOGIN_PASSWORD/)
  // …and bot B, in no group, reports the global one. The password itself is never printed.
  assert.match(out, /Login password: from LOGIN_PASSWORD/)
  assert.ok(!out.includes('group-pw'))
  assert.ok(!out.includes('global-pw'))
})

// planAuthAction holds the whole login/register guard and is a plain function on
// the module, so it can be driven directly rather than through a live mineflayer
// connection (which the harness deliberately never creates).
function plan(r, id, message, now) {
  const arg = now === undefined ? '' : `, ${now}`
  return plain(r.run(`planAuthAction(${JSON.stringify(id)}, ${JSON.stringify(message)}${arg})`))
}
const LOGIN_PROMPT = 'Please login using /login <password>'
const REGISTER_PROMPT = 'Please register using /register <password> <password>'

test('an auth prompt is answered with that bot\'s own password', () => {
  const r = runtime({
    LOGIN_PASSWORD: 'global-pw',
    BOT_PASSWORDS: 'B:own-pw',
    PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: 'h', PROXY_GROUP_1_LOGIN_PASSWORD: 'group-pw'
  })
  // Three sources, three answers, resolved per bot in the real module.
  assert.deepEqual(plan(r, 'A', LOGIN_PROMPT, 1000), { command: '/login group-pw', source: 'PROXY_GROUP_1_LOGIN_PASSWORD', kind: 'login' })
  assert.deepEqual(plan(r, 'B', LOGIN_PROMPT, 1000), { command: '/login own-pw', source: 'BOT_PASSWORDS', kind: 'login' })
  assert.deepEqual(plan(r, 'C', LOGIN_PROMPT, 1000), { command: '/login global-pw', source: 'LOGIN_PASSWORD', kind: 'login' })
  // /register sends it twice, the way AuthMe expects.
  assert.deepEqual(plan(r, 'C', REGISTER_PROMPT, 1000), { command: '/register global-pw global-pw', source: 'LOGIN_PASSWORD', kind: 'register' })
  // Ordinary server chatter is not an auth prompt.
  assert.deepEqual(plan(r, 'C', 'Welcome to FATALMC!', 1000), {})
})

// The .ENV tab is only worth having if its "live" claim is true, and that is not
// visible from a registry entry: a value is live when it is read at the point of
// use, and startup-only when bot.js copies it into a const while it loads. Both
// halves are pinned here, so moving a read from one to the other without moving
// the flag fails the suite instead of quietly turning the tab into a lie.
test('the registry calls a value live only when it is read where it is used', () => {
  const r = runtime(dataEnv())
  const live = plain(r.run(`(() => {
    const want = ['CRATES_ALL_DUMP', 'CRATES_ALL_AFK_WARP', 'CRATES_ALL_AFK_DELAY_MS', 'DUMP_HOME_COMMAND', 'TPA_MAIN_PLAYER', 'WARP_COMMAND', 'BOT_NAMES', 'ANALYTICS_PORT', 'LOGIN_PASSWORD', 'ALL_SLOW_DELAY_MS', 'AUTH_RETRY_MS']
    const out = {}
    settings.list().forEach(row => { if (want.includes(row.key)) out[row.key] = row.live })
    return out
  })()`))

  // Roster and listener wiring remain restart-only.
  for (const key of ['BOT_NAMES', 'ANALYTICS_PORT']) {
    assert.equal(live[key], false, key + ' is captured at boot, so the tab must not call it live')
  }
  // Read where they are used, so an override applies immediately.
  for (const key of ['CRATES_ALL_DUMP', 'CRATES_ALL_AFK_WARP', 'CRATES_ALL_AFK_DELAY_MS', 'DUMP_HOME_COMMAND', 'TPA_MAIN_PLAYER', 'WARP_COMMAND', 'LOGIN_PASSWORD', 'ALL_SLOW_DELAY_MS', 'AUTH_RETRY_MS']) {
    assert.equal(live[key], true, key + ' is read at the point of use, so the tab may call it live')
  }

  // The live half is not just a label. The auth path resolves the password out of
  // process.env at every attempt - which is what /env set and the .ENV tab write -
  // so a change reaches the next /auth-retry rather than the next restart.
  assert.deepEqual(plan(r, 'B', LOGIN_PROMPT, 1000), { command: '/login 123456', source: 'built-in default', kind: 'login' })
  r.run("process.env.LOGIN_PASSWORD = 'hunter2'")
  assert.deepEqual(plan(r, 'B', LOGIN_PROMPT, 2000), { command: '/login hunter2', source: 'LOGIN_PASSWORD', kind: 'login' })
})

test('a rejected login stops the bot answering prompts and alerts once', () => {
  const r = runtime({ LOGIN_PASSWORD: 'wrong-pw' })
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 1000).command, '/login wrong-pw')

  const failed = plan(r, 'A', 'Wrong password!', 1100)
  assert.equal(failed.record.kind, 'bad-password')
  assert.equal(failed.record.until, null, 'a wrong password is sticky, not a timed wait')
  assert.equal(failed.alert, true)
  assert.equal(r.run('authState.get("A").failure.kind'), 'bad-password')

  // From here the bot refuses to answer, so the account is never hammered.
  const skipped = plan(r, 'A', LOGIN_PROMPT, 1200)
  assert.equal(skipped.command, undefined)
  assert.equal(skipped.skip.kind, 'bad-password')
  assert.equal(skipped.skip.reason, 'Wrong password')

  // A failure is not re-notified on every prompt it suppresses.
  assert.equal(r.authAlerts.length, 0, 'the guard itself does not alert; the chat handler does')
})

test('a rejected login with a fallback password gets it once, after the configured wait', () => {
  const r = runtime({
    PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: 'h',
    PROXY_GROUP_1_LOGIN_PASSWORD: 'guess-one', PROXY_GROUP_1_FALLBACK_LOGIN_PASSWORD: 'guess-two',
    AUTH_FALLBACK_DELAY_MS: '6000'
  })
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 1000).command, '/login guess-one')

  // The rejection is not recorded as a failure yet: the fallback is the point.
  const rejected = plan(r, 'A', 'Wrong password!', 1100)
  assert.equal(rejected.record, undefined)
  assert.equal(rejected.alert, undefined)
  assert.deepEqual(rejected.fallback, {
    command: '/login guess-two', source: 'PROXY_GROUP_1_FALLBACK_LOGIN_PASSWORD', kind: 'login', delayMs: 6000
  })

  // A prompt during the wait is still answered with the fallback — the handler
  // delays the send rather than skipping, so a re-prompting server is fine.
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 3000).command, '/login guess-two')

  // The fallback gets exactly one shot: a second rejection is sticky, as before.
  const second = plan(r, 'A', 'Wrong password!', 9200)
  assert.equal(second.record.kind, 'bad-password')
  assert.equal(second.record.until, null)
  assert.equal(second.alert, true)
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 9300).skip.kind, 'bad-password')
})

test('a rejected /register retries the fallback as a registration too', () => {
  const r = runtime({ LOGIN_PASSWORD_FALLBACK: 'second', AUTH_FALLBACK_DELAY_MS: '6000' })
  assert.equal(plan(r, 'A', REGISTER_PROMPT, 1000).command, '/register 123456 123456')
  const rejected = plan(r, 'A', 'Register failed', 1100)
  assert.equal(rejected.fallback.command, '/register second second')
  assert.equal(rejected.fallback.kind, 'register')
  assert.equal(rejected.fallback.source, 'LOGIN_PASSWORD_FALLBACK')
})

test('a player typing a failure phrase, or a late one, cannot disable a bot', () => {
  const r = runtime({ LOGIN_PASSWORD: 'pw' })
  plan(r, 'A', LOGIN_PROMPT, 1000)

  // Looks like player chat (Name: message) rather than a server reply.
  assert.deepEqual(plan(r, 'A', 'Steve: wrong password lol', 1100), {})
  // Outside the reply window: nobody just sent an auth command for this to answer.
  const late = 1000 + r.run('AUTH_REPLY_WINDOW_MS') + 1
  assert.deepEqual(plan(r, 'A', 'Wrong password!', late), {})
  // Either way the bot is still able to log in.
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 2000).command, '/login pw')
  assert.equal(r.run('authState.get("A").failure === undefined'), true, 'nothing was recorded')
})

test('repeated throttling is waited out, then escalates to a wrong password', () => {
  const r = runtime({ LOGIN_PASSWORD: 'pw', AUTH_RETRY_MS: '1000', AUTH_MAX_THROTTLED_RETRIES: '2' })
  const throttled = 'Too many failed attempts, please wait 10 seconds before trying again'

  plan(r, 'A', LOGIN_PROMPT, 1000)
  const first = plan(r, 'A', throttled, 1100)
  assert.equal(first.record.kind, 'throttled')
  assert.equal(first.record.until, 2100)
  assert.equal(first.alert, true)

  // While the wait is running the prompt is refused…
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 1200).skip.kind, 'throttled')
  // …and once it expires the bot tries again by itself.
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 2101).command, '/login pw')

  const second = plan(r, 'A', throttled, 2102)
  assert.equal(second.record.kind, 'throttled')
  assert.equal(second.alert, false, 'the same kind of failure is only alerted once')

  // A third one is the end of the road: this is a wrong password wearing a hat.
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 3103).command, '/login pw')
  const third = plan(r, 'A', throttled, 3104)
  assert.equal(third.record.kind, 'bad-password')
  assert.equal(third.record.until, null)
  assert.equal(third.alert, true, 'escalating to a real failure is worth an alert')
  assert.match(third.record.reason, /repeated 3 times/)
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 9000).skip.kind, 'bad-password')
})

test('an "already logged in" reply is a short pause, never a credential verdict', () => {
  const r = runtime({ LOGIN_PASSWORD: 'pw', AUTH_ALREADY_MS: '5000' })
  plan(r, 'A', LOGIN_PROMPT, 1000)
  const already = plan(r, 'A', 'You are already logged in!', 1100)
  assert.equal(already.record.kind, 'already')
  assert.equal(already.record.until, 6100)
  // The previous connection's session has not expired yet — normal on a fast
  // reconnect — so this must not be treated as a wrong password.
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 1200).skip.kind, 'already')
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 6100).command, '/login pw')
})

test('/auth-retry clears a recorded failure so the bot can log in again', () => {
  const r = runtime({ LOGIN_PASSWORD: 'pw' })
  plan(r, 'A', LOGIN_PROMPT, 1000)
  plan(r, 'A', 'Wrong password!', 1100)
  assert.equal(r.run('authState.has("A")'), true)
  assert.ok(plan(r, 'A', LOGIN_PROMPT, 1200).skip)

  r.context.__lines = []
  r.run('subscribeLog((id, line) => __lines.push(String(line)))')
  r.timers.clear()
  r.run(`handleCommand('/auth-retry A')`)
  const out = r.context.__lines.join('\n')
  assert.match(out, /cleared bad-password/)
  assert.match(out, /Wrong password/)
  assert.equal(r.run('authState.has("A")'), false, 'the hold is cleared')
  // And the very next prompt is answered again.
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 1300).command, '/login pw')
})

test('/auth-retry reports a bot with nothing recorded, and refuses a stranger', () => {
  const r = runtime({ LOGIN_PASSWORD: 'pw' })
  r.context.__lines = []
  r.run('subscribeLog((id, line) => __lines.push(String(line)))')
  r.run(`handleCommand('/auth-retry A')`)
  assert.match(r.context.__lines.join('\n'), /no recorded auth failure/)
  r.context.__lines = []
  r.run(`handleCommand('/auth-retry ghost')`)
  assert.match(r.context.__lines.join('\n'), /No bot named "ghost"/)
})

test('/proxy names the login-password source, and reports a group with no proxy', () => {
  const r = runtime({
    PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_LOGIN_PASSWORD: 'pw-one',
    // Group 2 exists only to group accounts: no HOST, so no dedicated proxy.
    PROXY_GROUP_2_BOTS: 'B', PROXY_GROUP_2_LOGIN_PASSWORD: 'pw-two'
  })
  r.timers.clear()
  r.context.__lines = []
  r.run('subscribeLog((id, line) => __lines.push(String(line)))')
  r.run(`handleCommand('/proxy')`)
  const out = r.context.__lines.join('\n')

  assert.match(out, /\[1\] A → SOCKS5 1\.2\.3\.4:1080 · proxy auth: none · login: PROXY_GROUP_1_LOGIN_PASSWORD/)
  // A hostless group must not read as hosting a proxy at :0, and its password still applies.
  assert.match(out, /\[2\] B → no dedicated proxy \(uses the default connection\) · login: PROXY_GROUP_2_LOGIN_PASSWORD/)
  assert.doesNotMatch(out, /:0\b/, 'no made-up proxy address')
  assert.ok(!out.includes('pw-one') && !out.includes('pw-two'))
})

test('startup supports sparse group indexes without leaking credentials', () => {
  const r = runtime({
    PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: '1.2.3.4',
    // No PROXY_GROUP_2_*, but group 3 is valid.
    PROXY_GROUP_3_BOTS: 'B', PROXY_GROUP_3_LOGIN_PASSWORD: 'orphaned-pw'
  })
  r.timers.clear()
  const out = r.run('systemLogs.map(l => l.text).join("\\n")')
  assert.match(out, /PROXY_GROUP_3 has no HOST/)
  assert.equal(r.run(`resolveLoginPassword('B', PROXY_GROUPS, process.env).password`), 'orphaned-pw')
  assert.doesNotMatch(out, /ignored, no group declares them/)
  assert.ok(!out.includes('orphaned-pw'), 'the value is never printed')
})

test('startup says when a group carries no proxy of its own', () => {
  const r = runtime({ PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_LOGIN_PASSWORD: 'pw-one' })
  r.timers.clear()
  const out = r.run('systemLogs.map(l => l.text).join("\\n")')
  assert.match(out, /PROXY_GROUP_1 has no HOST — its 1 bot\(s\) use the default route, but its login password still applies/)
})

// Flushes every pending microtask so an awaited sequence has fully settled
// before the next assertion (the harness's timers are manual).
const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve))

// Every log line a runtime has produced — the global `log()` helpers write to
// the active bot's log, while startup warnings go to the system log.
function logsText (r) {
  return r.run("Object.keys(bots).map(id => bots[id].logs.map(l => l.text).join('\\n')).join('\\n') + '\\n' + systemLogs.map(l => l.text).join('\\n')")
}

// Fires every pending mocked timer once (and drops it), the way the real clock
// would as time passes.
function runPendingTimers (r) {
  for (const t of [...r.timers.values()]) { r.timers.delete(t); t.fn() }
}

// The sequence awaits real (mocked) timers between its steps, so a test driving
// it has to advance the clock until the promise settles.
async function driveSequence (r, promise) {
  let settled = false
  promise.then(() => { settled = true }, () => { settled = true })
  for (let i = 0; i < 50 && !settled; i++) {
    await flushMicrotasks()
    if (settled) break
    runPendingTimers(r)
  }
  return promise
}

// The sequence is what actually sends the warp, so it is stubbed out and the
// real runCratesAll is allowed to stagger + thread the plan through to it.
function captureSequence (r) {
  r.run(`
    captured = []
    runCratesAllSequenceForBot = (id, color, plan) => {
      captured.push({ id, color, plan: Object.assign({}, plan) })
      return Promise.resolve()
    }
  `)
  return () => plain(r.run('captured'))
}

test('/crates-all options default to the env values and are overridden per run', async () => {
  const r = runtime({ CRATES_ALL_DUMP: 'home', CRATES_ALL_AFK_DELAY_MS: '0' })
  const captured = captureSequence(r)

  r.run("handleCommand('/crates-all')")
  runPendingTimers(r)
  await flushMicrotasks()
  const withEnvDefaults = captured()
  assert.equal(withEnvDefaults.length, 3)
  assert.deepEqual(withEnvDefaults[0], { id: 'A', plan: { dump: 'home', target: '', afkWarp: true, afkDelayMs: 0 } })
  assert.match(logsText(r), /Starting \/crates-all for 3 bot\(s\) \[1–3\], 30s apart — dump via \/home stash, immediate \/warp afk…/)

  r.run("captured = []; handleCommand('/crates-all 1 purple dump=player:Smith afk=off')")
  runPendingTimers(r)
  await flushMicrotasks()
  const withFlags = captured()
  assert.equal(withFlags.length, 1)
  assert.equal(withFlags[0].color, 'purple_shulker_box')
  assert.equal(withFlags[0].plan.dump, 'tpa')
  assert.equal(withFlags[0].plan.target, 'Smith')
  assert.equal(withFlags[0].plan.afkWarp, false)
})

test('/crates-solo takes the same dump=/afk= flags', async () => {
  const r = runtime()
  const captured = captureSequence(r)

  r.run("handleCommand('/crates-solo B dump=off afk=now')")
  await flushMicrotasks()
  assert.deepEqual(captured(), [{ id: 'B', plan: { dump: 'off', target: '', afkWarp: true, afkDelayMs: 0 } }])

  // A bare word is not a target: it is a typo, and a typo must not teleport a
  // bot to a player whose name happens to match it.
  r.run("captured = []; handleCommand('/crates-solo B dump=Smith')")
  await flushMicrotasks()
  assert.deepEqual(captured(), [])
  assert.match(logsText(r), /Unknown option "dump=Smith"/)

  r.run("captured = []; handleCommand('/crates-solo B dump=player:Smith afk=off')")
  await flushMicrotasks()
  assert.deepEqual(captured(), [{ id: 'B', plan: { dump: 'tpa', target: 'Smith', afkWarp: false, afkDelayMs: 15000 } }])

  // A token the parser cannot read must warn and run nothing at all — the
  // whole point of reporting instead of guessing.
  r.run("captured = []; handleCommand('/crates-solo B foo=bar')")
  await flushMicrotasks()
  assert.deepEqual(captured(), [])
  assert.match(logsText(r), /Unknown option "foo=bar"\. Usage: \/crates-solo \[bot name or number\] \[color\]/)
})

test('/crates-all afk=now warps the moment the routine ends, afk=off never warps', async () => {
  const r = runtime()
  await r.run(`
    chats = []
    bots.A.bot = { entity: {}, chat(msg) { chats.push(msg) } }
    runShardshopLoop = async () => ({ runs: 1, stopReason: 'message' })
    runCrateRoutine = async () => true
  `)

  // dump=off keeps this off the real TPA/chest path.
  await driveSequence(r, r.run("runCratesAllSequenceForBot('A', null, cratesAllPlan(parseCratesAllFlags(['dump=off', 'afk=now'])))"))
  assert.deepEqual(plain(r.run('chats')), ['/warp afk'])
  assert.ok(r.run("bots.A.logs.map(l => l.text).some(line => line.includes('Dump step skipped (dump=off)'))"), 'dump=off must skip the dump step')

  r.run('chats = []')
  await driveSequence(r, r.run("runCratesAllSequenceForBot('A', null, cratesAllPlan(parseCratesAllFlags(['dump=off', 'afk=off'])))"))
  assert.deepEqual(plain(r.run('chats')), [], 'afk=off must never warp')

  // The default is unchanged: a 15s wait before the warp, so the warp is not
  // sent until that timer fires.
  r.run('chats = []')
  const pending = r.run("runCratesAllSequenceForBot('A', null, cratesAllPlan(parseCratesAllFlags(['dump=off'])))")
  await flushMicrotasks()
  runPendingTimers(r) // the wait between the crate step and the dump step
  await flushMicrotasks()
  assert.deepEqual(plain(r.run('chats')), [], 'the default warp waits 15s')
  assert.ok([...r.timers.values()].some(t => t.delay === 15000), 'a 15s warp timer is pending')
  await driveSequence(r, pending)
  assert.deepEqual(plain(r.run('chats')), ['/warp afk'])
})

test('dump=hidden turns the AFK warp off unless the run asks for one', async () => {
  const r = runtime()
  // A hidden dump leaves each bot where it TPA'd to, so warping AFK afterwards
  // would undo it.
  assert.equal(r.run("cratesAllPlan(parseCratesAllFlags(['dump=hidden'])).afkWarp"), false)
  assert.equal(r.run("cratesAllPlan(parseCratesAllFlags(['dump=hidden', 'afk=now'])).afkWarp"), true)
  // CRATES_ALL_AFK_WARP=true is still overruled by dump=hidden, since the
  // documented reason for hidden is staying put.
  const hiddenEnv = runtime({ CRATES_ALL_DUMP: 'hidden', CRATES_ALL_AFK_WARP: 'true' })
  assert.equal(hiddenEnv.run('cratesAllPlan({}).dump'), 'hidden')
  assert.equal(hiddenEnv.run('cratesAllPlan({}).afkWarp'), false)
})

test('/play embeds the client once a build exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-built-'))
  const dist = path.join(dir, 'dist')
  fs.mkdirSync(dist, { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>built</title>')
  // An off-the-beaten-path port: the harness mocks bot.js's own http module, but
  // web-client.js is loaded for real and would otherwise bind the default 8090.
  const r = runtime({ MC_WEB_AUTO_BUILD: 'false', MC_WEB_CLIENT_DIR: dist, MC_WEB_CLIENT_PORT: '47899' })
  r.timers.clear()
  const cookie = await r.login()
  const res = await r.request('/play', '', cookie, 'GET')
  assert.equal(res.status, 200)
  assert.match(res.body, /<iframe/)
  assert.doesNotMatch(res.body, /build not found/)
  try { wcModule.stopWebClient(r.run('webHandle.webClient'), () => {}) } catch (_) {}
})

// The balance being sampled is the bot's WHOLE-player balance, so one run's
// spawner rows are slices of the same number. This drives the real
// runSpawnerRoutine with stubbed clicks to pin down where the total is kept.
test('/spawners accumulates earnings on the bot row and publishes inventory usage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawner-data-'))
  const r = runtime({ DATA_FILE: path.join(dir, 'spawner-data.json') })
  await r.run(`
    chats = []
    var balances = [100, 130, 200, 250]
    bots.A.bot = {
      entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 1 } },
      game: { dimension: 'overworld' },
      registry: { blocksByName: { spawner: { id: 1 } } },
      inventory: { slots: Object.assign(new Array(46).fill(null), { 9: { name: 'stone' }, 10: { name: 'stone' }, 11: { name: 'stone' } }) },
      findBlocks: () => [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }],
      currentWindow: null
    }
    clickSpawnerOnce = async () => ({ ok: true, balanceBefore: 0, balanceAfter: balances.shift() })
    queryBalance = async () => 250
  `)

  // Run 1 only establishes each spawner's baseline balance — nothing is earned yet.
  await driveSequence(r, r.run("runSpawnerRoutine('A')"))
  assert.equal(r.run('dataState.spawners["A:1"].balance'), 100)
  assert.equal(r.run('dataState.spawners["A:1"].earned'), null)
  assert.equal(r.run('dataState.spawners["A:1"].lifetimeEarned'), undefined, 'no per-spawner lifetime column any more')
  assert.equal(r.run('dataState.bots.A.lifetimeEarned'), 0)
  assert.equal(r.run('dataState.bots.A.invUsed'), 3)
  assert.equal(r.run('dataState.bots.A.invFree'), 33)
  assert.equal(r.run('dataState.bots.A.invTotal'), 36)

  // A leftover row from an earlier, larger run must not keep a stale measurement.
  r.run("dataStore.upsertSpawner(dataState, { bot: 'A', spawnerNumber: 3, earned: 999, ratePerHour: 999 })")

  await driveSequence(r, r.run("runSpawnerRoutine('A')"))
  assert.equal(r.run('dataState.spawners["A:1"].earned'), 100, 'the row keeps its own slice')
  assert.equal(r.run('dataState.spawners["A:2"].earned'), 120)
  // 100 + 120 is the whole run, which is what the bot actually earned.
  assert.equal(r.run('dataState.bots.A.earned'), 220)
  assert.equal(r.run('dataState.bots.A.lifetimeEarned'), 220)
  assert.ok(r.run('dataState.bots.A.ratePerHour') > 0, 'the rate comes from the run window')
  const stale = plain(r.run('dataState.spawners["A:3"]'))
  assert.equal(stale.earned, null, 'a row this run did not visit is not counted into the sheet total')
  assert.equal(stale.ratePerHour, null)
  assert.equal(stale.calculationStatus, 'not seen this run')

  // A second completed run keeps accumulating on the same bot row.
  r.run('balances = [300, 400]')
  await driveSequence(r, r.run("runSpawnerRoutine('A')"))
  assert.equal(r.run('dataState.bots.A.lifetimeEarned'), 220 + (300 - 200) + (400 - 250))
  assert.equal(r.run('dataState.bots.A.lifetimeEarned'), 470)
})

// ── Coinflip data runs, time series, analytics and the .ENV settings tab ─────

// Its own history files per runtime: these commands write records, and the
// repo's data folder is not a test fixture.
function dataEnv (env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-data-'))
  return {
    COINFLIP_FILE: path.join(dir, 'coinflip-history.jsonl'),
    COINFLIP_DEEP_FILE: path.join(dir, 'coinflip-deep.json'),
    COINFLIP_EXPORT_FILE: path.join(dir, 'coinflip-export.csv'),
    TIMESERIES_FILE: path.join(dir, 'timeseries.jsonl'),
    // Short enough that a run in a test gets as far as sending the create.
    COINFLIP_POLL_MS: '1000',
    // The production default is a real 2.5s wait in front of every create;
    // these tests would sit on a timer the harness never fires. The cooldown
    // has its own test, which sets it back up per run.
    COINFLIP_CREATE_COOLDOWN_MS: '0',
    ...env
  }
}

// A bot whose balance queries get real answers. `queryBalance` waits for a reply
// that *parses* — the shard and coin replies are labelled, the money reply is
// not (and deliberately ignores the labelled ones) — so the fake has to answer
// the command it was sent. Replying to every message at once would leave
// /shards and /coins waiting on a timer this harness never fires.
function payingBot (id, balance, extra = {}) {
  const shards = extra.shards == null ? 1234 : extra.shards
  const coins = extra.coins == null ? 567 : extra.coins
  // The live /bal reply changed wording ("Balance: $0.40" → "Payments | Your
  // balance is $1k."), so the default answer uses the current format; pass
  // moneyReply to exercise another shape (legacy wording, abbreviations).
  const moneyReply = extra.moneyReply || `Payments | Your balance is $${balance}`
  return `(() => {
    const listeners = bots.__payingListeners || (bots.__payingListeners = [])
    bots.${id}.bot = {
      entity: {}, health: 20, food: 20,
      chat(msg) {
        chats.push(['${id}', msg])
        const reply = msg === '/shards' ? 'Shards | Balance: ${shards}'
          : msg === '/coins' ? 'Coins | Balance: ${coins}'
            : /^\\/bal\\b/.test(msg) ? '${moneyReply}'
              : null
        if (reply == null) return
        listeners.slice().forEach(fn => fn({ toString: () => reply }))
      },
      once() {}, removeListener() {},
      on(event, fn) { if (event === 'message') listeners.push(fn) }
    }
  })()`
}

test('queryBalance parses the live Payments reply, abbreviated amounts, and the legacy wording', async () => {
  const r = runtime()

  // The live /bal wording, with the server's abbreviated amount.
  r.run(payingBot('A', 1000, { moneyReply: 'Payments | Your balance is $1k.' }))
  assert.equal(await r.run('queryBalance("A", "Balance", "/bal")'), 1000)

  // Abbreviations scale ($1.5m = 1500000) and commas still strip ($1,250).
  r.run(payingBot('A', 0, { moneyReply: 'Payments | Your balance is $1.5m.' }))
  assert.equal(await r.run('queryBalance("A", "Balance", "/bal")'), 1500000)
  r.run(payingBot('A', 0, { moneyReply: 'Payments | Your balance is $1,250.' }))
  assert.equal(await r.run('queryBalance("A", "Balance", "/bal")'), 1250)

  // The legacy wording must keep parsing — servers roll out wording changes
  // gradually and a downgrade would otherwise blind every balance consumer.
  r.run(payingBot('A', 0, { moneyReply: 'Balance: $0.40' }))
  assert.equal(await r.run('queryBalance("A", "Balance", "/bal")'), 0.4)

  // Shards/Coins stay on the labelled wording.
  r.run(payingBot('A', 0, { shards: 2500, coins: 12 }))
  assert.equal(await r.run('queryBalance("A", "Shards", "/shards")'), 2500)
  assert.equal(await r.run('queryBalance("A", "Coins", "/coins")'), 12)

  // A pending money query must ignore labelled replies: production fires all
  // three commands at once and every reply reaches every listener, so without
  // the guard the money query would latch onto "Shards | Balance: 2500".
  r.run(`(() => {
    const listeners = bots.__payingListeners || (bots.__payingListeners = [])
    bots.A.bot = { entity: {}, chat() {}, once() {}, removeListener() {},
      on(event, fn) { if (event === 'message') listeners.push(fn) } }
  })()`)
  const money = r.run('queryBalance("A", "Balance", "/bal")')
  r.run("bots.__payingListeners.slice().forEach(fn => fn({ toString: () => 'Shards | Balance: 2500' }))")
  r.run("bots.__payingListeners.slice().forEach(fn => fn({ toString: () => 'Payments | Your balance is $7.' }))")
  assert.equal(await money, 7)
})

// The coinflip commands only; a balance query is also chat traffic.
const coinflipChats = (r) => plain(r.run("chats.filter(c => c[1].startsWith('/coinflip'))"))

const channelLogs = (r, ...ids) => ids
  .map(id => (id === 'system' ? r.run('systemLogs.map(l => l.text)') : r.run(`bots.${id}.logs.map(l => l.text)`)))
  .flat()
  .join('\n')

test('/bot-coinflip run sends one create for the requested wager and remembers the session', async () => {
  const r = runtime(dataEnv())
  r.run(payingBot('A', 50000))
  r.run("handleCommand('/bot-coinflip run 1000 2 A', { selectedId: 'A' })")
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(coinflipChats(r), [['A', '/coinflip create 1000']])
  assert.equal(r.run('coinflipSessions.get("A").planned'), 2)
  assert.equal(r.run('coinflipSessions.get("A").stopped'), 'running')
  // Nothing about a busy or unanswered flip may ever delete it.
  assert.equal(r.run("chats.some(c => /delete/.test(c[1]))"), false)

  // A refusal from the server ends the run, and the bot is then free to run again.
  r.run("coinflipObserverFor('A').feed('You do not have enough money for this coinflip bet')")
  await new Promise(resolve => setTimeout(resolve, 1300))
  assert.match(channelLogs(r, 'A'), /stopped: insufficient-balance/)
  assert.equal(r.run('coinflipSessions.has("A")'), false)
  assert.equal(r.run('coinflipLastRun.get("A").stopped'), 'insufficient-balance')
})

test('/bot-coinflip run takes a named bot, and an unknown name is reported rather than guessed at', async () => {
  const r = runtime(dataEnv())
  r.run(payingBot('B', 50000))
  r.run("handleCommand('/bot-coinflip run 500 1 B')")
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(coinflipChats(r), [['B', '/coinflip create 500']])
  r.run("coinflipObserverFor('B').feed('You do not have enough money for this coinflip bet')")
  await new Promise(resolve => setTimeout(resolve, 1300))

  r.run('chats = []')
  r.run("handleCommand('/bot-coinflip run 500 1 Ghost')")
  assert.deepEqual(plain(r.run('chats')), [])
  assert.match(channelLogs(r, 'A', 'B', 'system'), /No bot named/)
})

test('an unreadable PRICE is refused and no coinflip is sent', () => {
  const r = runtime(dataEnv())
  r.run("handleCommand('/bot-coinflip run 5x 2 A', { selectedId: 'A' })")
  assert.deepEqual(plain(r.run('chats')), [])
  assert.match(channelLogs(r, 'A', 'system'), /Unknown option/)
})

test('/bot-coinflip run is dispatched per bot, which is what /all-slow needs', async () => {
  const r = runtime(dataEnv())
  r.run(payingBot('B', 50000))
  r.run("dispatchCommandToBot('/bot-coinflip run 250 1', 'B')")
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(coinflipChats(r), [['B', '/coinflip create 250']])
  assert.equal(r.run('coinflipSessions.has("A")'), false, 'the selected bot is not the target here')
  r.run("coinflipObserverFor('B').feed('You do not have enough money for this coinflip bet')")
  await new Promise(resolve => setTimeout(resolve, 1300))
})

// ── One /bot-coinflip suite: run, stats, deep, history and export under one name ─

test('/bot-coinflip with no subcommand lists the suite and the recorded totals', () => {
  const r = runtime(dataEnv())
  r.run("coinflipStore.append({ id: 'x1', bot: 'A', ts: 1700000000000, wager: 1000, result: 'won', delta: 1000, method: 'message' })")
  r.run("handleCommand('/bot-coinflip', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /── \/bot-coinflip ──/)
  assert.match(logs, /1 resolved flip\(s\) \(1W\/0L\)/)
  assert.match(logs, /\/bot-coinflip run \[PRICE\] \[AMOUNT\] \[BOT\|all\]/)
  assert.match(logs, /\/bot-coinflip deep \[BOT\]/)
  assert.match(logs, /\/bot-coinflip export \[BOT\]/)
  // A bare /bot-coinflip is the console's; it must not land in the game as chat.
  assert.deepEqual(plain(r.run('chats')), [])
})

test('/bot-coinflip run plays and records exactly what /bot-coinflip run did', async () => {
  const r = runtime(dataEnv())
  r.run(payingBot('A', 50000))
  r.run("handleCommand('/bot-coinflip run 1200 2 A', { selectedId: 'A' })")
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(coinflipChats(r), [['A', '/coinflip create 1200']])
  assert.equal(r.run('coinflipSessions.get("A").planned'), 2)
  assert.equal(r.run('coinflipSessions.get("A").stopped'), 'running')
  r.run("coinflipObserverFor('A').feed('You do not have enough money for this coinflip bet')")
  await new Promise(resolve => setTimeout(resolve, 1300))
  assert.equal(r.run('coinflipSessions.has("A")'), false)
})

test('/bot-coinflip run is dispatched per bot, which is what /all-slow needs now', async () => {
  const r = runtime(dataEnv())
  r.run(payingBot('B', 50000))
  r.run("dispatchCommandToBot('/bot-coinflip run 250 1', 'B')")
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(coinflipChats(r), [['B', '/coinflip create 250']])
  assert.equal(r.run('coinflipSessions.has("A")'), false, 'the selected bot is not the target here')
  r.run("coinflipObserverFor('B').feed('You do not have enough money for this coinflip bet')")
  await new Promise(resolve => setTimeout(resolve, 1300))
})

test('/bot-coinflip stats and /bot-coinflip history answer on the merged names', () => {
  const r = runtime(dataEnv())
  r.run("coinflipStore.append({ id: 'x1', bot: 'A', ts: 1700000000000, wager: 1000, result: 'won', delta: 1000, opponent: 'Rival', method: 'message' })")
  r.run("handleCommand('/bot-coinflip stats A', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /1 resolved \(1W\/0L\)/)

  r.run("handleCommand('/bot-coinflip history', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /Last 1 coinflip\(s\)/)

  r.run('chats = []')
  r.run("handleCommand('/bot-coinflip history clear', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /\/bot-coinflip history clear confirm/)
  assert.equal(r.run('coinflipStore.all().length'), 1, 'clear without confirm changes nothing')
})

test('/bot-coinflip deep finds the same dissection the older name found', () => {
  const r = runtime(dataEnv())
  for (let i = 0; i < 40; i++) {
    r.run(`coinflipStore.append({ id: 'd${i}', bot: 'A', ts: ${1700000000000 + i * 60000}, wager: 1000, result: '${i % 2 ? 'won' : 'lost'}', delta: ${i % 2 ? 1000 : -1000}, balanceBefore: 50000, method: 'message', serverHour: ${8 + (i % 4)} })`)
  }
  r.run("handleCommand('/bot-coinflip deep A', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /Coinflip dissection \(A\)/)
  assert.match(logs, /40 resolved flip\(s\)/)
  assert.match(logs, /What the numbers say/)
})

test('/bot-coinflip export reports every flip and where the CSV went', () => {
  const r = runtime(dataEnv())
  r.run("coinflipStore.append({ index: 1, id: 'x1', bot: 'A', ts: 1700000000000, wager: 1000, result: 'won', delta: 1000, opponent: 'Rival', balanceBefore: 50000, balanceAfter: 51000, method: 'message', serverHour: 9 })")
  r.run("coinflipStore.append({ index: 2, id: 'x2', bot: 'B', ts: 1700000060000, wager: 2000, result: 'lost', delta: -2000, balanceBefore: 40000, balanceAfter: 38000, method: 'recreate' })")
  r.run("handleCommand('/bot-coinflip export', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /2 flip\(s\) exported to .*coinflip-export\.csv/)
  assert.match(logs, /columns: index, ts, utc, bot, result, wager, opponent, delta/)

  r.run('bots.A.logs.length = 0')
  r.run("handleCommand('/bot-coinflip export B', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /1 flip\(s\) exported/, 'the bot argument scopes the export')

  r.run('bots.A.logs.length = 0')
  r.run("handleCommand('/bot-coinflip export Ghost', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /No bot named "Ghost"/, 'an unknown bot is reported, not widened to the fleet')
})

test('the server owns /coinflip and the suite owns /bot-coinflip', () => {
  const r = runtime(dataEnv())
  r.run(payingBot('A', 50000))
  // /coinflip is a SERVER command, so the console must not own that name: a bare
  // one and the game's own subcommands all reach the bot as ordinary chat.
  r.run("handleCommand('/coinflip', { selectedId: 'A' })")
  r.run("handleCommand('/coinflip create 10000', { selectedId: 'A' })")
  r.run("handleCommand('/coinflip delete', { selectedId: 'A' })")
  assert.deepEqual(plain(r.run("chats.map(c => c[1])")), ['/coinflip', '/coinflip create 10000', '/coinflip delete'])
  assert.equal(r.run('coinflipSessions.size'), 0, 'the console did not start a data run')

  // The suite name refuses a subcommand it does not own instead of inventing
  // server chat out of it, and points at the game's command.
  r.run('bots.A.logs.length = 0')
  r.run("handleCommand('/bot-coinflip create 10000', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /Unknown \/bot-coinflip subcommand "create"/)
  assert.match(logs, /plain \/coinflip/)
  assert.equal(r.run("chats.filter(c => c[1].startsWith('/bot-coinflip')).length"), 0, 'never forwarded as chat')
})

test('/bot-coinflip stats reports the recorded numbers, the streak and the fairness verdict', () => {
  const r = runtime(dataEnv())
  r.run("coinflipStore.append({ id: 'x1', bot: 'A', ts: 1700000000000, wager: 1000, result: 'won', delta: 1000, opponent: 'Rival', method: 'message' })")
  r.run("coinflipStore.append({ id: 'x2', bot: 'A', ts: 1700000001000, wager: 1000, result: 'lost', delta: -1000, opponent: 'Rival', method: 'message' })")
  r.run("handleCommand('/bot-coinflip stats A', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /2 resolved \(1W\/1L\)/)
  assert.match(logs, /net: \$0/)
  assert.match(logs, /fairness verdict: insufficient-data/)
  assert.match(logs, /per opponent:/)
  assert.match(logs, /Rival: 2 flips/)
})

test('/bot-coinflip stats on an empty history says how to fill it instead of printing zeros', () => {
  const r = runtime(dataEnv())
  r.run("handleCommand('/bot-coinflip stats', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /No coinflip history for the whole fleet yet/)
  assert.match(channelLogs(r, 'A'), /run \/bot-coinflip run/)
})

test('/bot-coinflip history lists the flips and needs a confirmation to erase them', () => {
  const r = runtime(dataEnv())
  r.run("coinflipStore.append({ id: 'x1', bot: 'A', ts: 1700000000000, wager: 2000, result: 'lost', delta: -2000, opponent: 'Rival', method: 'message' })")
  r.run("handleCommand('/bot-coinflip history', { selectedId: 'A' })")
  let logs = channelLogs(r, 'A')
  assert.match(logs, /Last 1 coinflip\(s\)/)
  assert.match(logs, /\$2,000/)

  r.run("handleCommand('/bot-coinflip history clear', { selectedId: 'A' })")
  assert.equal(r.run('coinflipStore.all().length'), 1, 'clear without confirm changes nothing')
  assert.match(channelLogs(r, 'A'), /clear confirm/)

  r.run("handleCommand('/bot-coinflip history clear confirm', { selectedId: 'A' })")
  assert.equal(r.run('coinflipStore.all().length'), 0)
})

test('/timeseries status shows the cadence, the file and the metrics', () => {
  const r = runtime(dataEnv())
  r.run("handleCommand('/timeseries status', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /Time series/)
  assert.match(logs, /sampling: on/)
  assert.match(logs, /samples: 0/)
  assert.match(logs, /shards: no data yet/)
})

test('/timeseries series reports the recorded samples and where the JSON is', () => {
  const r = runtime(dataEnv())
  r.run("recordTimeseriesSample('A', { shards: 10 }, 'test')")
  r.run("recordTimeseriesSample('A', { shards: 40 }, 'test')")
  r.run("recordFleetSample('test')")
  r.run("handleCommand('/timeseries series shards', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /shards \(fleet\)/)
  assert.match(logs, /\/api\/timeseries\?metric=shards/)
  // The last bucket is printed even when there are too few points for a line.
  assert.match(logs, /40/)

  // Per bot, the same metric is scoped to that bot's own samples.
  r.run("handleCommand('/timeseries series shards 1h A', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /shards · A/)
})

test('the analytics report is built from the same history and samples the page reads', () => {
  // Warm-up skip off: this test records samples *now* and reads them straight
  // back. The skip itself has its own test below and in timeseries.test.js.
  const r = runtime(dataEnv({ ANALYTICS_WARMUP_MS: '0' }))
  r.run("coinflipStore.append({ id: 'x1', bot: 'A', ts: 1700000000000, wager: 1000, result: 'won', delta: 1000, method: 'message' })")
  r.run("recordTimeseriesSample('A', { shards: 10, coins: 1, balance: 100 }, 'test'); recordFleetSample('test')")
  const report = plain(r.run('buildAnalyticsReport()'))
  assert.equal(report.headline.coinflips, 1)
  assert.equal(report.headline.shardsNow, 10)
  assert.equal(report.coinflip.stats.wins, 1)
  assert.ok(report.timeseries.bots.includes('A'))
  assert.match(r.run('analytics.renderHtml(buildAnalyticsReport())'), /Fairness verdict/)
})

test('charts and deltas skip the first 50 minutes after a run start by default', () => {
  const r = runtime(dataEnv())
  r.run("recordTimeseriesSample('A', { shards: 10, coins: 1, balance: 100 }, 'test'); recordFleetSample('test')")
  assert.equal(r.run("settings.get('ANALYTICS_WARMUP_MS')"), 3000000)
  const snap = plain(r.run("timeseriesStore.snapshot({ bucketMs: settings.get('ANALYTICS_BUCKET_MS'), warmupMs: settings.get('ANALYTICS_WARMUP_MS') })"))
  assert.equal(snap.warmupMs, 3000000)
  assert.equal(snap.warmupSkipped, 1, 'the sample inside the ramp is left out')
  assert.equal(snap.summary.shards, null)
  assert.equal(r.run('buildAnalyticsReport().timeseries.warmupSkipped'), 1, 'the report the page reads applies the same skip')
  // …and raw=1 in /api/timeseries puts it back for whoever wants to see it.
  assert.equal(r.run("timeseriesStore.bucket('shards', { warmupMs: 0 }).length"), 1)
})

test('the time-series sampler records a bot sample and a fleet total', async () => {
  const r = runtime(dataEnv())
  r.run(payingBot('A', 50000))
  r.run('startTimeseriesSampler()')
  assert.ok(r.run('cfDuration(settings.get("TIMESERIES_INTERVAL_MS"))') === '1h 0m')

  const sampled = await r.run("sampleTimeseriesNow({ source: 'test' })")
  assert.equal(sampled, 1)
  const rows = plain(r.run('timeseriesStore.all()'))
  assert.equal(rows.length, 2, 'the bot sample and the fleet total')
  assert.equal(rows[0].kind, 'bot')
  assert.equal(rows[0].balance, 50000)
  assert.equal(rows[0].source, 'test')
  assert.equal(rows[1].kind, 'fleet')
  assert.equal(rows[1].balance, 50000)
  assert.equal(rows[1].bots, 1)
})

test('time-series sampling records nothing when it is switched off', async () => {
  const r = runtime(dataEnv({ TIMESERIES_ENABLED: 'false' }))
  r.run(payingBot('A', 50000))
  await r.run("sampleTimeseriesNow({ source: 'test' })")
  assert.equal(r.run('timeseriesStore.all().length'), 0)
  assert.equal(r.run("recordTimeseriesSample('A', { shards: 1 }, 'test')"), null)
})

test('the analytics server serves the page and the JSON, and needs a session', async () => {
  const r = runtime(dataEnv())
  r.run("coinflipStore.append({ id: 'x1', bot: 'A', ts: 1700000000000, wager: 1000, result: 'won', delta: 1000, method: 'message' })")
  // Sign in through the dashboard first: the cookie is shared across ports.
  const cookie = await r.login()
  r.run('startAnalyticsServer()')

  const port = r.run("settings.get('ANALYTICS_PORT')")
  const page = await r.request('/', '', cookie, 'GET', port)
  assert.equal(page.status, 200, page.body)
  assert.match(page.body, /AFK <b>ANALYTICS<\/b>/)
  assert.match(page.body, /Fleet over time|No samples yet/)
  assert.match(page.body, /Fairness verdict/)

  const json = JSON.parse((await r.request('/api/analytics', '', cookie, 'GET', port)).body)
  assert.ok(json.generatedAt > 0)
  assert.ok(json.coinflip && json.timeseries && json.headline)
  assert.equal(json.headline.coinflips, 1)
  assert.equal(json.headline.coinflipNet, 1000)

  const series = JSON.parse((await r.request('/api/timeseries?metric=shards&bucket=1h', '', cookie, 'GET', port)).body)
  assert.equal(series.metric, 'shards')
  assert.equal(series.bucketMs, 3600000)

  // Without the session it explains how to get in rather than leaking the data.
  const denied = await r.request('/api/analytics', '', '', 'GET', port)
  assert.equal(/generatedAt/.test(denied.body), false)
  assert.match(denied.body, /dashboard session/)

  assert.equal((await r.request('/health', '', '', 'GET', port)).body, 'ok')

  // The dashboard runs on its own server and must still be the one on its port.
  assert.equal((await r.request('/health', '', '', 'GET')).body, 'ok')
  assert.equal((await r.request('/api/settings', '', '', 'GET')).status, 303)
})

test('analytics can be switched off entirely', () => {
  const r = runtime(dataEnv({ ANALYTICS_ENABLED: 'false' }))
  assert.equal(r.run('startAnalyticsServer()'), null)
})

test('/analytics points at the page and at the JSON behind it', () => {
  const r = runtime(dataEnv())
  r.run("handleCommand('/analytics', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /http:\/\/localhost:8080\//)
  assert.match(logs, /\/api\/analytics/)
  assert.match(logs, /\/api\/export/)
})

test('/env lists the registry and marks the keys a restart is needed for', () => {
  const r = runtime(dataEnv())
  r.run("handleCommand('/env list coinflip', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /Coinflip/)
  assert.match(logs, /COINFLIP_WAGER_MIN = 10000/)
  assert.match(logs, /COINFLIP_STOP_LOSS = 10000000/)
  assert.match(logs, /temporary override\(s\)/)
})

test('/env set applies immediately and /env reset removes it', () => {
  const r = runtime(dataEnv())
  r.run("handleCommand('/env set COINFLIP_WAGER_MIN 5000', { selectedId: 'A' })")
  assert.equal(r.run("settings.get('COINFLIP_WAGER_MIN')"), 5000)
  assert.match(channelLogs(r, 'A'), /temporary — not saved/)

  r.run("handleCommand('/env get COINFLIP_WAGER_MIN', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /COINFLIP_WAGER_MIN: 5000/)
  assert.match(channelLogs(r, 'A'), /\(override\)/)

  r.run("handleCommand('/env reset COINFLIP_WAGER_MIN', { selectedId: 'A' })")
  assert.equal(r.run("settings.get('COINFLIP_WAGER_MIN')"), 10000)
})

test('a value that cannot be parsed is refused by /env instead of silently reverting', () => {
  const r = runtime(dataEnv())
  r.run("handleCommand('/env set COINFLIP_STOP_LOSS lots', { selectedId: 'A' })")
  assert.equal(r.run("settings.get('COINFLIP_STOP_LOSS')"), 10000000)
  assert.match(channelLogs(r, 'A'), /not a valid int/)
})

test('/env set refuses a wrong variable name instead of setting it silently', () => {
  const r = runtime(dataEnv())
  // The "I set the wrong .env variable" case: nothing reads this name, so a
  // silent success would look like it worked while changing nothing.
  r.run("handleCommand('/env set COINFLIP_WAGER_MI 5000', { selectedId: 'A' })")
  assert.equal(r.run("settings.isKnownKey('COINFLIP_WAGER_MI')"), false)
  assert.match(channelLogs(r, 'A'), /No setting named "COINFLIP_WAGER_MI"/)
  assert.match(channelLogs(r, 'A'), /COINFLIP_WAGER_MIN/, 'the real name is suggested')
  // Case typos land on the registered key instead of an inert shadow.
  r.run("handleCommand('/env set coinflip_wager_min 7000', { selectedId: 'A' })")
  assert.equal(r.run("settings.get('COINFLIP_WAGER_MIN')"), 7000)
  r.run("handleCommand('/env reset COINFLIP_WAGER_MIN', { selectedId: 'A' })")
})

test('a startup-only key says so rather than pretending the change took effect', () => {
  const r = runtime(dataEnv())
  r.run("handleCommand('/env set BOT_NAMES A,B,C,D', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /read once at startup/)
})

test('/env reset-all clears every temporary override', () => {
  const r = runtime(dataEnv())
  // Overrides live in the settings module, not in this runtime, so start clean.
  r.run('settings.resetAll()')
  r.run("handleCommand('/env set COINFLIP_WAGER_MIN 5000', { selectedId: 'A' })")
  r.run("handleCommand('/env set COINFLIP_WAGER_MAX 6000', { selectedId: 'A' })")
  assert.equal(r.run('settings.overrideCount()'), 2)
  r.run("handleCommand('/env reset-all', { selectedId: 'A' })")
  assert.equal(r.run('settings.overrideCount()'), 0)
  assert.match(channelLogs(r, 'A'), /Cleared 2 temporary override/)
})

test('the dashboard .ENV tab reads and writes the same registry, and rejects bad input', async () => {
  const r = runtime(dataEnv())
  r.run('settings.resetAll()')
  const cookie = await r.login()
  const list = await r.request('/api/settings', '', cookie, 'GET')
  assert.equal(list.status, 200)
  const groups = JSON.parse(list.body).groups
  assert.ok(groups.some(group => group.group === 'Coinflip' && group.rows.some(row => row.key === 'COINFLIP_STOP_LOSS')))

  const set = await r.request('/api/settings', JSON.stringify({ key: 'COINFLIP_STOP_LOSS', value: '250000' }), cookie, 'POST')
  assert.equal(set.status, 200)
  assert.equal(JSON.parse(set.body).ok, true)
  assert.equal(r.run("settings.get('COINFLIP_STOP_LOSS')"), 250000)

  const bad = await r.request('/api/settings', JSON.stringify({ key: 'COINFLIP_STOP_LOSS', value: 'lots' }), cookie, 'POST')
  assert.equal(bad.status, 400)
  assert.match(JSON.parse(bad.body).error, /not a valid int/)

  const reset = await r.request('/api/settings/reset', JSON.stringify({ all: true }), cookie, 'POST')
  assert.equal(JSON.parse(reset.body).cleared, 1)
  assert.equal(r.run("settings.get('COINFLIP_STOP_LOSS')"), 10000000)
})

test('the settings API needs the session, like every other dashboard route', async () => {
  const r = runtime(dataEnv())
  const res = await r.request('/api/settings', '', '', 'GET')
  assert.equal(res.status, 303)
})

test('a secret is listed as set, never echoed back to the dashboard', async () => {
  const r = runtime(dataEnv())
  const cookie = await r.login()
  const res = await r.request('/api/settings', JSON.stringify({ key: 'WEB_PASSWORD', value: 'a-new-secret' }), cookie, 'POST')
  assert.equal(JSON.parse(res.body).secret, true)
  assert.equal(JSON.parse(res.body).value, null)
  const list = JSON.parse((await r.request('/api/settings', '', cookie, 'GET')).body)
  const row = list.groups.flatMap(group => group.rows).find(entry => entry.key === 'WEB_PASSWORD')
  assert.equal(row.value, null)
  assert.equal(row.secret, true)
  assert.equal(r.run("settings.list().find(r => r.key === 'WEB_PASSWORD').value"), null)
  await r.request('/api/settings/reset', JSON.stringify({ all: true }), cookie, 'POST')
})

// ── The deep dissection: /bot-coinflip deep, the report and the page ─────────────

// Seeding goes through the real store, with COINFLIP_FILE pointed at a temp
// file by dataEnv(), so nothing lands in the repo's data folder.
function seedHistory (r, rows) {
  r.run(`coinflipStore.appendAll(${JSON.stringify(rows)})`)
}

function seededFlip (i, over = {}) {
  const won = i % 3 !== 0
  return {
    id: `seed-${i}`,
    sessionId: `seed-session-${Math.floor(i / 10)}`,
    bot: 'A',
    index: (i % 10) + 1,
    ts: 1770000000000 + i * 60000,
    wager: 10000,
    opponent: 'Rival',
    result: won ? 'won' : 'lost',
    balanceBefore: 1000000,
    balanceAfter: null,
    delta: won ? 10000 : -10000,
    method: 'message',
    mismatched: false,
    serverHour: 14,
    serverClock: '2:00 P.M.',
    ...over
  }
}

test('/bot-coinflip deep dissects the stored flips and names every dissection', () => {
  const r = runtime(dataEnv({ COINFLIP_DEEP_MIN_BUCKET: '3' }))
  r.run("handleCommand('/bot-coinflip deep', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A', 'system'), /No coinflip history for the fleet/)

  seedHistory(r, Array.from({ length: 60 }, (_, i) => seededFlip(i)))
  r.run("handleCommand('/bot-coinflip deep A', { selectedId: 'A' })")
  const text = channelLogs(r, 'A', 'B', 'system')
  assert.match(text, /Coinflip dissection \(A\)/)
  assert.match(text, /Does the previous flip predict the next one\?/)
  assert.match(text, /Runs and what follows them/)
  assert.match(text, /Wager as a share of the balance/)
  assert.match(text, /Time of day/)
  assert.match(text, /Pace and idling/)
  assert.match(text, /The money curve/)
  assert.match(text, /What the numbers say/)
  assert.match(text, /statistical test\(s\) corrected together at q=0\.05/)
  // The hour comes off the record's own server stamp, not our clock.
  assert.match(text, /hours read from the server clock/)

  const report = plain(r.run('coinflipDeepReport()'))
  assert.equal(report.resolved, 60)
  assert.ok(report.sections.length >= 13, `${report.sections.length} dissections`)
  assert.ok(report.tests > 10, `${report.tests} tests in the family`)
  assert.equal(report.hourSource, 'server')
  assert.ok(report.takeaways.length >= 4)
  // Same history, same report — the cache is not allowed to change the numbers.
  assert.equal(r.run('coinflipDeepReport() === coinflipDeepReport()'), true)
  assert.equal(r.run('persistCoinflipDeepReport().resolved'), 60)
})

test('/bot-coinflip deep can be scoped to one bot and an empty scope says so', () => {
  const r = runtime(dataEnv({ COINFLIP_DEEP_MIN_BUCKET: '2' }))
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => seededFlip(i)),
    ...Array.from({ length: 30 }, (_, i) => seededFlip(i, { bot: 'B', id: `seed-b-${i}` }))
  ]
  seedHistory(r, rows)
  assert.equal(r.run('coinflipDeepReport().resolved'), 60)
  assert.equal(r.run('coinflipDeepReport({ bot: "B" }).resolved'), 30)
  assert.equal(r.run('coinflipDeepReport({ bot: "B" }).bot'), 'B')

  r.run("handleCommand('/bot-coinflip deep B', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A', 'B', 'system'), /Coinflip dissection \(B\)/)
  r.run("handleCommand('/bot-coinflip deep Ghost', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A', 'B', 'system'), /No coinflip history for Ghost/)
})

test('the analytics report and page carry the dissection', () => {
  const r = runtime(dataEnv({ COINFLIP_DEEP_MIN_BUCKET: '3' }))
  seedHistory(r, Array.from({ length: 45 }, (_, i) => seededFlip(i)))

  const report = plain(r.run('buildAnalyticsReport({ recent: 0 })'))
  assert.equal(report.deep.resolved, 45)
  assert.ok(report.deep.sections.length >= 13)
  assert.equal(report.headline.coinflips, 45)
  assert.ok(report.config.coinflipDeepFile.endsWith('coinflip-deep.json'))

  // The deep dissection is its own tab: the page ships the tab shell and the
  // loader, and the section HTML (deepHtml) is what the tab fills in from
  // /api/coinflip/deep — so the assertions live on the section, not the shell.
  const html = r.run("analytics.renderHtml(buildAnalyticsReport())")
  assert.match(html, /Deep dissection/)
  assert.match(html, /\/api\/coinflip\/deep/)
  assert.equal(/undefined|NaN/.test(html), false, 'no placeholder leaked into the page')

  const deepHtml = report.deepHtml
  assert.match(deepHtml, /What the numbers say/)
  assert.match(deepHtml, /statistical tests/)
  // Every dissection gets a table, every table and row is closed, and no
  // template placeholder survived the render.
  const tables = deepHtml.split('<table>').length - 1
  assert.equal(deepHtml.split('</table>').length - 1, tables, 'every table is closed')
  assert.ok(tables >= 13, `${tables} dissection tables`)
  assert.equal(deepHtml.split('<tr').length, deepHtml.split('</tr>').length, 'every row is closed')
  assert.equal(/undefined|NaN/.test(deepHtml), false, 'no placeholder leaked into the section')
})

test('the create waits out the configured cooldown after the balance answer', async () => {
  const r = runtime(dataEnv())
  r.run(payingBot('A', 50000))
  // Nothing is reset between runtimes, so clear any override another test left.
  r.run("settings.reset('COINFLIP_CREATE_COOLDOWN_MS')")
  const before = r.run("settings.get('COINFLIP_CREATE_COOLDOWN_MS')")
  try {
    r.run("handleCommand('/env set COINFLIP_CREATE_COOLDOWN_MS 400', { selectedId: 'A' })")
    assert.equal(r.run("settings.get('COINFLIP_CREATE_COOLDOWN_MS')"), 400)

    r.run("handleCommand('/bot-coinflip run 1000 1 A', { selectedId: 'A' })")
    await flushMicrotasks()
    // The balance was asked for and the run is parked on the cooldown: this is
    // the gap that stops the server answering "you are on cooldown".
    const parked = [...r.timers.values()].filter(timer => timer.delay === 400)
    assert.equal(parked.length, 1, 'one 400ms wait, between /bal and the create')
    assert.deepEqual(coinflipChats(r), [])

    parked[0].fn()
    await flushMicrotasks()
    assert.deepEqual(coinflipChats(r), [['A', '/coinflip create 1000']])

    // Let the flip finish so the run does not outlive the test.
    for (const line of ['Result: Won', 'Amount Bet: $1,000', 'Winner: A', 'Loser: Rival']) {
      r.run(`coinflipObserverFor('A').feed(${JSON.stringify(line)})`)
    }
    await flushMicrotasks()
    assert.equal(r.run('coinflipSessions.has("A")'), false)
  } finally {
    r.run("settings.reset('COINFLIP_CREATE_COOLDOWN_MS')")
  }
  assert.equal(r.run("settings.get('COINFLIP_CREATE_COOLDOWN_MS')"), before, 'the override is gone')
})

test('the new coinflip knobs are registered, live, and described for the .ENV tab', () => {
  const r = runtime(dataEnv())
  const keys = plain(r.run('settings.registered()'))
  for (const key of [
    'COINFLIP_CREATE_COOLDOWN_MS',
    'COINFLIP_COOLDOWN_MAX_RETRIES',
    'COINFLIP_DEEP_MIN_BUCKET',
    'COINFLIP_DEEP_Q',
    'COINFLIP_TZ_OFFSET_MIN'
  ]) {
    assert.ok(keys.includes(key), `${key} is registered`)
    const row = plain(r.run(`settings.list().find(entry => entry.key === '${key}')`))
    assert.equal(row.group, 'Coinflip')
    assert.equal(row.live, true, `${key} is read where it is used`)
    assert.ok(row.desc.length > 10, `${key} explains itself in the tab`)
  }
  // A value outside the allowed range is refused rather than silently clamped.
  assert.equal(r.run("settings.set('COINFLIP_DEEP_Q', '5').ok"), false)
  assert.equal(r.run("settings.set('COINFLIP_CREATE_COOLDOWN_MS', '2s').value"), 2000)
  r.run("settings.reset('COINFLIP_CREATE_COOLDOWN_MS')")
})


// ── /dump filters, hidden dump, crates pass-through, /doc ────────────────────

test('/dump term filters match names and NBT, and never teleport when nothing matches', async () => {
  const r = runtime({ TPA_MAIN_PLAYER: 'Main' })
  r.timers.clear()
  r.run(`
    bots.A.bot.entity = { position: { x: 0, y: 0, z: 0, clone: () => ({ x: 0, y: 0, z: 0, distanceTo: () => 0 }) } }
    bots.A.bot.on = () => {}
    bots.A.bot.removeListener = () => {}
    bots.A.bot.registry = { blocksByName: { chest: { id: 54 }, trapped_chest: { id: 146 }, yellow_shulker_box: { id: 242 } } }
    bots.A.bot.findBlocks = () => []
    bots.A.bot.inventory = { items: () => [
      { name: 'diamond_sword', displayName: 'Diamond Sword', count: 1, slot: 1 },
      // A renamed chestplate whose ONLY netherite evidence is its NBT material
      // tag — exactly the "Fatal Chestplate is netherite" case.
      { name: 'iron_chestplate', displayName: 'Fatal Chestplate', count: 1, slot: 2, nbt: { value: { Material: { value: 'netherite' } } } }
    ] }
  `)
  // Nothing matches: the dump must stop BEFORE sending any /tpa.
  await r.run(`handleCommand('/dump "zzz"')`)
  assert.match(logsText(r), /no items match "zzz"/)
  assert.deepEqual(plain(r.context.chats), [], 'a filter that matches nothing must not teleport')
  // "netherite" matches the Fatal Chestplate through its NBT material tag.
  await driveSequence(r, r.run(`handleCommand('/dump "netherite" yellow')`))
  const text = logsText(r)
  assert.match(text, /1 stack\(s\) match "netherite"/)
  assert.match(text, /1 stack\(s\) stay behind/)
  assert.match(text, /yellow shulker box/)
  assert.match(text, /No matching containers found/)
  assert.deepEqual(plain(r.context.chats), [['A', '/tpa Main'], ['A', '/warp afk']])
})

test('/dump hidden keeps at most DUMP_HIDDEN_CONCURRENT bots at the spot and resets each one', async () => {
  const r = runtime({ TPA_MAIN_PLAYER: 'Main', DUMP_HIDDEN_CONCURRENT: '2', DUMP_HIDDEN_MIN_GAP_MS: '1000', DUMP_HIDDEN_MAX_GAP_MS: '1000' })
  r.timers.clear()
  r.run(`
    for (const id of ['A', 'B', 'C']) {
      bots[id].bot.entity = { position: { x: 0, y: 0, z: 0, clone: () => ({ x: 0, y: 0, z: 0, distanceTo: () => 0 }) } }
      bots[id].bot.on = () => {}
      bots[id].bot.removeListener = () => {}
      bots[id].bot.registry = { blocksByName: { chest: { id: 54 }, trapped_chest: { id: 146 } } }
      bots[id].bot.findBlocks = () => []
      bots[id].bot.inventory = { items: () => [{ name: 'stone', displayName: 'Stone', count: 1, slot: 1 }] }
    }
    activeDumps = new Set()
    maxDumpConcurrent = 0
    realTpaAndDump = tpaAndDump
    tpaAndDump = (bot, id, opts) => {
      activeDumps.add(id)
      maxDumpConcurrent = Math.max(maxDumpConcurrent, activeDumps.size)
      return realTpaAndDump(bot, id, opts).finally(() => activeDumps.delete(id))
    }
    handleCommand('/dump hidden')
  `)
  // Drive the fake clock until the run reports itself finished.
  for (let i = 0; i < 100 && !r.run('hiddenDumpRun === null'); i++) {
    await flushMicrotasks()
    runPendingTimers(r)
  }
  assert.equal(r.run('hiddenDumpRun === null'), true, 'the hidden run must finish')
  const text = logsText(r)
  assert.match(text, /Hidden dump started: 3 bot\(s\), at most 2 at the spot/)
  assert.match(text, /Hidden dump finished: 3\/3 bot\(s\) dumped/)
  assert.match(text, /Hidden dump action 1\/3/)
  assert.match(text, /Hidden dump action 3\/3/)
  const chats = plain(r.context.chats)
  assert.equal(chats.filter(c => c[1] === '/tpa Main').length, 3, 'every bot TPA\'s to the main player')
  assert.equal(chats.filter(c => c[1] === '/warp afk').length, 3, 'every bot resets with the AFK warp')
  assert.ok(r.run('maxDumpConcurrent') <= 2, 'never more than DUMP_HIDDEN_CONCURRENT bots at the spot')
})

test('/crates-solo threads quoted dump filters into the dump step', async () => {
  const r = runtime()
  const captured = captureSequence(r)

  r.run(`handleCommand('/crates-solo B "fatal" shulker dump=hidden')`)
  const [run1] = captured()
  assert.equal(run1.id, 'B')
  assert.equal(run1.plan.dump, 'hidden')
  assert.deepEqual(run1.plan.filter, { terms: ['fatal'], types: ['shulker'], colors: [] })

  // The first bare colour BEFORE any filter token is still the crate colour.
  r.run(`captured = []; handleCommand('/crates-solo B purple "fatal" dump=hidden')`)
  const [run2] = captured()
  assert.equal(run2.color, 'purple_shulker_box')
  assert.deepEqual(run2.plan.filter.terms, ['fatal'])

  // A colour after a filter token narrows the dump's shulker boxes.
  r.run(`captured = []; handleCommand('/crates-solo B "fatal" shulker yellow dump=hidden')`)
  const [run3] = captured()
  assert.deepEqual(run3.plan.filter, { terms: ['fatal'], types: ['shulker'], colors: ['yellow'] })

  // A plain run still carries no filter key at all.
  r.run(`captured = []; handleCommand('/crates-solo B dump=off afk=now')`)
  const [run4] = captured()
  assert.equal('filter' in run4.plan, false)
})

test('/doc lists the built-in docs and opens a topic', async () => {
  const r = runtime()
  r.run(`handleCommand('/doc')`)
  let text = logsText(r)
  assert.match(text, /Docs index/)
  assert.match(text, /dump-hidden/)
  r.run(`handleCommand('/doc hidden')`)
  text = logsText(r)
  assert.match(text, /Docs — hidden/)
  assert.match(text, /DUMP_HIDDEN_CONCURRENT/)
  r.run(`handleCommand('/doc no-such-topic-xyz')`)
  assert.match(logsText(r), /No docs topic matches "no-such-topic-xyz"/)
})
