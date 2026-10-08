'use strict'
// Manual-only browser harness; not picked up by npm test and never dials Minecraft.
// node test/ui-preview-harness.js (port defaults to 4821)
const fs = require('fs')
const vm = require('vm')
const http = require('http')
const { WebSocketServer } = require('ws')
const analytics = require('../analytics')
const coinflip = require('../coinflip')
const analysis = require('../analysis')
const timeseries = require('../timeseries')
const panel = require('../coinflip-dashboard-static')
const xterm = require('../xterm-static')
const source = fs.readFileSync(require('path').join(__dirname, '..', 'bot.js'), 'utf8')
const start = source.indexOf('const PAGE_HTML = ')
const end = source.indexOf('// ── Web GUI server', start)
const html = vm.runInNewContext(source.slice(start, end) + '; PAGE_HTML', { DASHBOARD_TITLE: 'Isolated UI check', WEB_REFRESH_MS: 1000 })
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const page = html.replace('<!--PLAYBTN-->', '<button id="playbtn">PLAY</button>').replace(/<script>[\s\S]*?<\/script>/, '<script src="/app.js"></script>')
const t0 = Date.now() - 5 * 3600000
const flips = Array.from({ length: 20 }, (_, index) => ({ id: `flip-${index}`, bot: index % 2 ? 'Bravo' : 'Alpha', ts: t0 + index * 60000, result: index % 3 ? 'won' : 'lost', wager: 123.123456789, delta: index % 3 ? 123.123456789 : -123.123456789 }))
const rows = Array.from({ length: 5 }, (_, index) => ({ t: t0 + index * 3600000, kind: 'fleet', bots: index % 2 ? 1 : 2, shards: (index % 2 ? 1 : 2) * (100.123456789 + index), coins: 10, balance: 200, runStartedAt: t0 }))
const store = timeseries.createTimeseriesStore({ file: 'preview-only', fs: { readFileSync() { throw Error('ENOENT') }, mkdirSync() {}, appendFileSync() {} } })
rows.forEach(row => store.append(row))
const summary = { stats: coinflip.computeStats(flips), fairness: coinflip.analyzeFairness(flips), recent: flips.slice().reverse() }
const deep = analysis.deepAnalysis(flips)
const report = analytics.buildReport({ coinflip: summary, deep, timeseries: store.snapshot({ warmupMs: 3000000 }) })
const commandRows = [{ command: '/home', usages: ['/home', '/home <name>'] }, { command: '/rtp', usages: ['/rtp', '/rtp world <world>'] }, { command: '/warp', usages: ['/warp', '/warp <destination>'] }]
const commands = { '/server-commands [filter] [--refresh]': 'Browse commands advertised to this account', '/new-gen [count] [group=auto|direct|N]': 'Save generated accounts before connecting' }
const bots = [
  { id: 'Alpha', number: 1, state: 'online', online: true, health: 20, food: 20, ping: 45, pingHist: [20, 30] },
  { id: 'Bravo', number: 2, state: 'disconnected', online: false, disconnectReason: 'Connection lost', disconnectedAt: Date.now() },
  { id: 'Charlie', number: 3, state: 'banned', online: false, banned: true, kick: 'Banned by server', banKind: 'temporary' },
  { id: 'Removed', removed: true, state: 'banned', online: false, banned: true, kick: 'Permanent ban' }
]
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const send = (body, type = 'application/json') => { res.writeHead(200, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body) }
  if (url.pathname === '/') return send(page, 'text/html')
  if (url.pathname === '/analytics') return send(analytics.renderHtml(report), 'text/html')
  if (url.pathname === '/app.js') return send(script, 'application/javascript')
  if (url.pathname === '/chart.js') return send(panel.getChartJs(), 'application/javascript')
  if (url.pathname === '/coinflip-dashboard.js') return send(panel.getCoinflipDashboardJs(), 'application/javascript')
  if (url.pathname === '/xterm.js' || url.pathname === '/xterm-addon-fit.js' || url.pathname === '/xterm.css') return xterm.handleXtermAsset(req, res)
  if (url.pathname === '/api/analytics') return send(report)
  if (url.pathname === '/api/coinflip/summary') return send(summary)
  if (url.pathname === '/api/coinflip/deep') return send(deep)
  if (url.pathname === '/api/coinflip/fairness') return send(summary.fairness)
  if (url.pathname === '/api/coinflip/bot') return send({ rows: flips.filter(row => row.bot === url.searchParams.get('bot')), summary })
  if (url.pathname === '/api/coinflip/bots') return send({ bots: Object.fromEntries(summary.stats.bots.map(row => [row.bot, row])) })
  if (url.pathname === '/api/server-commands') return send({ bot: url.searchParams.get('bot') || 'Alpha', received: true, source: 'tree', updatedAt: 1, commands: commandRows })
  if (url.pathname === '/api/state') return send({ bots, stats: { bots: 3, online: 1 }, commands, lines: [], terminalEnabled: true })
  res.writeHead(404); res.end('not found')
})
const wss = new WebSocketServer({ server })
// Terminal messages are answered by a fake shell that emits real ANSI escapes
// (colors, cursor moves, reverse video) so the xterm.js panel can be checked
// in a browser without SSH: open → banner, input → echoed back.
wss.on('connection', ws => {
  ws.send(JSON.stringify({ t: 'hello', bots, stats: { bots: 3, online: 1 }, commands, cmdHistory: [], terminalEnabled: true }))
  ws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw) } catch (_) { return }
    if (msg.t === 'sub') { ws.send(JSON.stringify({ t: 'history', id: msg.id, lines: [] })); return }
    if (msg.t !== 'terminal') return
    if (msg.action === 'open') {
      ws.send(JSON.stringify({ t: 'terminal', data: '\x1b[2J\x1b[H\x1b[1;32m[xterm harness]\x1b[0m emulator check — \x1b[1;33myellow\x1b[0m \x1b[1;36mcyan\x1b[0m \x1b[7mreverse\x1b[0m \x1b[41mred-bg\x1b[0m\r\n\x1b[31mrow 2\x1b[0m cursor: \x1b[10;5Hmoved(10,5)\x1b[K\x1b[20;1H$ ' }))
    } else if (msg.action === 'input' && typeof msg.data === 'string') {
      ws.send(JSON.stringify({ t: 'terminal', data: msg.data.replace(/\r/g, '\r\n$ ') }))
    }
  })
})
const port = Number(process.env.UI_PREVIEW_PORT) || 4821
server.listen(port, '127.0.0.1', () => console.log(`UI harness http://127.0.0.1:${port}/ PID ${process.pid}`))
