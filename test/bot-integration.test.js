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
  let requestHandler
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
  const processMock = {
    // MC_WEB_AUTO_BUILD is forced off here (the app default is ON): with it on,
// a /play request for an unbuilt client would clone and build the real
// multi-GB upstream client from the test suite. Tests that need a build point
// MC_WEB_CLIENT_DIR at a temp dir instead.
  env: { BOT_NAMES: 'A,B,C', WEB_GUI: 'true', TUI_GUI: 'false', WEB_PASSWORD: 'test-only', WEB_TERMINAL_LOG: 'false', MC_WEB_AUTO_BUILD: 'false', CRON_STATE_FILE: cronStateFile, ...env },
    stdout: { isTTY: false, write() {} }, stderr: { write() {} },
    on() {}, exit() {}, memoryUsage: () => ({ rss: 0, heapUsed: 0 }), uptime: () => 1
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8')
  const context = vm.createContext({
    Buffer, URL, URLSearchParams, console, process: processMock, __dirname: path.join(__dirname, '..'),
    setTimeout: setTimer, clearTimeout: clearTimer,
    setInterval: setTimer, clearInterval: clearTimer, setImmediate: fn => setTimer(fn, 0),
    require(name) {
      if (name === 'dotenv') return { config() {} }
      if (name === 'fs') return { readFileSync: () => '', writeFileSync() {}, mkdirSync() {}, renameSync() {}, existsSync: () => false }
      if (name === 'http') return { createServer(fn) { requestHandler = fn; return server } }
      if (name === 'ws') return fakeWs
      if (name === './bot-controls') return {
        ...controls,
        createSlowBroadcast: () => controls.createSlowBroadcast({ setTimer, clearTimer }),
        createSlowBroadcastManager: () => controls.createSlowBroadcastManager({ setTimer, clearTimer }),
        // bot-controls reads the real process.env by default, but inside this
        // harness bot.js reads processMock.env — so the group vars have to be
        // parsed from the same object bot.js sees, exactly as they would be in
        // production where there is only one process.env.
        parseProxyGroups: (env = processMock.env) => controls.parseProxyGroups(env)
      }
      if (name === './expose-terminal') return { sshConfig: () => ({ enabled: false }) }
      if (name === './monitoring') return {
        // A ban verdict that matches nothing, so the kick path stays exercised
        // without a live connection.
        classifyKick: message => ({ banned: false, permanent: false, kind: '', duration: '', durationMs: 0, expiresAt: 0, reason: String(message ?? ''), caseId: '', text: String(message ?? '') }),
        createMonitoring: () => ({ getMemorySnapshot: () => null, onDisconnect() {}, onKick() {}, onBan() {}, onProxyStall() {}, onReconnectExhausted() {}, onFatal() {}, onSecurityLockout() {}, inspectServerMessage() {}, onRecovered() {} })
      }
      // Resolved against this test file, not against bot.js, so it needs an entry.
      if (name === './removed-bots') return require('../removed-bots')
      if (name === './bot-manual') return () => ({ routeCommand: () => false, key() {}, onWindowOpen: () => false, onWindowClose() {}, stopManualMode() {}, snapshotFor: () => null })
      if (name === 'mineflayer') return { createBot() { throw Error('Live bot connections forbidden in tests') } }
      if (name === 'mineflayer-armor-manager') return () => {}
      if (name === 'mineflayer-pathfinder') return { goals: {} }
      if (name === 'socks') return {}
      if (name === './cron') return require('../cron')
      if (name === './web-client') return require('../web-client')
      return require(name)
    }
  })
  vm.runInContext(source.slice(0, source.indexOf('// ── Interface startup')), context)
  const run = code => vm.runInContext(code, context)
  const initialOrder = Array.from(run('initialBotOrder'))
  timers.clear()
  run(`
    for (const id of ['A', 'B', 'C']) bots[id] = {
      bot: { entity: {}, health: 20, food: 20, chat(msg) { chats.push([id, msg]) } },
      logs: [], disconnectManually() {}
    }
    activeId = 'A'
  `)
  context.chats = []
  run('webHandle = startWebGUI()')
  async function request(url, body = '', cookie = '', method = 'POST') {
    const req = new EventEmitter()
    Object.assign(req, { url, method, headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } })
    const response = { status: 0, headers: {}, body: '', writeHead(s, h = {}) { this.status = s; this.headers = h }, end(b = '') { this.body = b } }
    const done = requestHandler(req, response)
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
  function socket(cookie) {
    const ws = new EventEmitter()
    Object.assign(ws, { readyState: 1, messages: [], send(text) { this.messages.push(JSON.parse(text)) }, ping() {}, destroy() {} })
    server.emit('upgrade', { url: '/ws', headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } }, ws, Buffer.alloc(0))
    ws.command = msg => ws.emit('message', JSON.stringify(msg))
    return ws
  }
  return { context, run, timers, initialOrder, request, login, socket }
}

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
  r.run(`handleCommand('/all-slow hello')`)
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
  r.run(`handleCommand('/all-slow hello'); handleCommand('/exit')`)
  assert.equal(r.run('slowBroadcast.running'), false)
})

test('bare broadcasts give usage; normal /all stays immediate', () => {
  const r = runtime()
  r.run(`handleCommand('/all'); handleCommand('/all-slow')`)
  assert.deepEqual(plain(r.context.chats), [])
  r.run(`handleCommand('/all hello')`)
  assert.deepEqual(plain(r.context.chats), [['A', 'hello'], ['B', 'hello'], ['C', 'hello']])
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
  // and the ban hold (otherwise the next reconnect is held again).
  r.run(`handleCommand('/removed')`)
  r.run(`handleCommand('/unban')`)
  r.run(`handleCommand('/unban ghost')`)
  assert.equal(r.run('removedEntryFor("A").bot'), 'A', 'a bare or unknown /unban changes nothing')

  r.run('dataState.bots.A = { banned: true, banKind: "permanent", banExpiresAt: 0 }')
  r.run(`handleCommand('/unban A')`)
  assert.equal(r.run('removedEntryFor("A")'), null, 'the bot is off the removed list')
  assert.equal(r.run('dataState.bots.A.banned'), false, 'and its ban hold is cleared')

  assert.equal(r.run('PERMANENT_BAN_ACTION'), 'remove', 'a permanent ban defaults to leaving the roster')
})

// activeBan is what both the startup loop and scheduleReconnect ask before
// dialling, so it is worth pinning down through bot.js rather than only in isolation.
test('activeBan holds a live ban and releases an expired one', () => {
  const r = runtime()
  r.run(`
    dataState.bots.B = { banned: true, banKind: 'permanent', banExpiresAt: 0 }
    dataState.bots.C = { banned: true, banKind: 'temporary', banExpiresAt: Date.now() - 1000 }
    dataState.bots.D = { banned: true, banKind: 'temporary', banExpiresAt: Date.now() + 60000 }
  `)
  assert.equal(r.run('activeBan("B").permanent'), true, 'no expiry is a permanent hold')
  assert.equal(r.run('activeBan("C")'), null, 'an elapsed ban is no longer held')
  assert.equal(r.run('activeBan("D").permanent'), false)
  assert.ok(r.run('activeBan("D").expiresAt') > Date.now())
  assert.equal(r.run('activeBan("A")'), null, 'an unbanned bot is never held')
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
  r.run(`handleCommand('/all hello')`)
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
  const r = runtime()
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
  r.run(`handleCommand('/all-slow first')`)
  r.run(`handleCommand('/all-slow second')`)

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
  assert.match(out, /\[1\] A → SOCKS5 alice@1\.2\.3\.4:1080 · auth: PROXY_GROUP_1_USER\/_PASS/)
  // Group 2 has none, and must say so rather than implying it borrows the global pair.
  assert.match(out, /\[2\] B → HTTP 5\.6\.7\.8:1080 · auth: none/)
  assert.match(out, /SOCKS5 globaluser@9\.9\.9\.9:1080 \(authenticated\)/)
  assert.ok(out.includes('never shared with a group'))
  assert.ok(!out.includes('group-one-secret'), 'group password leaked into /proxy output')
  assert.ok(!out.includes('global-secret'), 'global password leaked into /proxy output')
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
