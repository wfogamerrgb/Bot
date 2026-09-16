'use strict'

// ── Spawner production data store ───────────────────────────────────────────
// Records what every /spawners run produced, bot by bot:
//
//   • one row per RUN — balance before, balance after, the time since that
//     bot's previous /spawners run, the $ earned this run and the $/hour rate
//     derived from that interval (N/A on the first run — baseline only);
//   • one row per SPAWNER in the run — its index ("Spawner 1", "Spawner 2", …),
//     its coordinates, the bot's position, and the $ delta measured by running
//     /bal after that spawner was clicked.
//
// Storage is intentionally dependency-free: SQLite through the built-in
// node:sqlite module when the runtime has it (Node 22.5+), with a plain JSON
// file as the fallback so Node 18/20 hosts keep working. Both are created
// lazily — importing this module never touches the disk.
//
// The /data command in bot.js compiles these runs into a snapshot and pushes it
// to a Google Sheets Apps Script webhook (overwriting one current row per
// bot/spawner), with a local JSON backup next to the store.

const fs = require('fs')
const path = require('path')

const RUNS_TABLE = 'spawner_runs'
const MAX_JSON_RUNS = 5000
const SNAPSHOT_FILE = 'latest-snapshot.json'

// ── number helpers ──────────────────────────────────────────────────────────
function isNum (value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function round2 (value) {
  return isNum(value) ? Math.round(value * 100) / 100 : null
}

// $ earned over the interval since the previous run → $ per hour. Returns null
// (rendered as N/A) when either input is missing, which is exactly the
// first-run / no-baseline case.
function computeEarnedPerHour (earned, intervalMs) {
  if (!isNum(earned) || !isNum(intervalMs) || intervalMs <= 0) return null
  return round2(earned / (intervalMs / 3600000))
}

function formatMoney (value) {
  if (!isNum(value)) return 'N/A'
  return '$' + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatInterval (ms) {
  if (!isNum(ms) || ms <= 0) return 'N/A'
  const totalMinutes = Math.round(ms / 60000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

// Normalizes one run record so both backends and every consumer agree on the
// shape (and so nothing but null/number/string ever reaches node:sqlite, which
// rejects booleans).
function normalizeRun (record = {}) {
  const startedAt = isNum(record.startedAt) ? record.startedAt : Date.now()
  const finishedAt = isNum(record.finishedAt) ? record.finishedAt : startedAt
  const balanceStart = round2(record.balanceStart)
  const balanceEnd = round2(record.balanceEnd)
  const earned = isNum(record.earned)
    ? round2(record.earned)
    : (isNum(balanceStart) && isNum(balanceEnd) ? round2(balanceEnd - balanceStart) : null)
  const intervalMs = isNum(record.intervalMs) && record.intervalMs > 0 ? Math.round(record.intervalMs) : null
  const spawners = Array.isArray(record.spawners)
    ? record.spawners.map((s, i) => ({
      index: isNum(s.index) ? s.index : i + 1,
      label: s.label || `Spawner ${isNum(s.index) ? s.index : i + 1}`,
      x: round2(s.x),
      y: round2(s.y),
      z: round2(s.z),
      block: s.block || null,
      balanceBefore: round2(s.balanceBefore),
      balanceAfter: round2(s.balanceAfter),
      earned: isNum(s.earned) ? round2(s.earned) : null,
      status: s.status || 'ok'
    }))
    : []
  return {
    id: null,
    bot: String(record.bot || 'unknown'),
    startedAt,
    finishedAt,
    intervalMs,
    balanceStart,
    balanceEnd,
    earned,
    earnedPerHour: isNum(record.earnedPerHour) ? round2(record.earnedPerHour) : computeEarnedPerHour(earned, intervalMs),
    botPosition: record.botPosition && isNum(record.botPosition.x)
      ? {
        x: round2(record.botPosition.x),
        y: round2(record.botPosition.y),
        z: round2(record.botPosition.z),
        dimension: record.botPosition.dimension || null
      }
      : null,
    spawnerCount: spawners.length,
    spawners,
    createdAt: isNum(record.createdAt) ? record.createdAt : Date.now()
  }
}

function createSpawnerDataStore ({ dir, kind, log = () => {} } = {}) {
  const baseDir = dir || process.env.SPAWNER_DATA_DIR || path.join(__dirname, 'data')
  const sqlitePath = path.join(baseDir, 'spawner-data.sqlite')
  const jsonPath = path.join(baseDir, 'spawner-data.json')
  const requestedKind = (kind || process.env.SPAWNER_DATA_STORE || 'auto').toLowerCase()

  let backend = null

  function openSqlite () {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(sqlitePath)
    db.exec(`CREATE TABLE IF NOT EXISTS ${RUNS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      interval_ms INTEGER,
      balance_start REAL,
      balance_end REAL,
      earned REAL,
      earned_per_hour REAL,
      bot_x REAL,
      bot_y REAL,
      bot_z REAL,
      bot_dimension TEXT,
      spawner_count INTEGER NOT NULL DEFAULT 0,
      spawners TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    )`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${RUNS_TABLE}_bot_finished ON ${RUNS_TABLE} (bot, finished_at DESC)`)
    return { kind: 'sqlite', db }
  }

  function readJson () {
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
      return Array.isArray(parsed?.runs) ? parsed.runs : []
    } catch (_) { return [] }
  }

  function writeJson (runs) {
    // Atomic-ish: write a temp file then rename, so a crash mid-write can never
    // leave a truncated store behind.
    const tmp = jsonPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: Date.now(), runs }, null, 2))
    fs.renameSync(tmp, jsonPath)
  }

  function ensure () {
    if (backend) return backend
    fs.mkdirSync(baseDir, { recursive: true })
    if (requestedKind !== 'json') {
      try {
        backend = openSqlite()
        return backend
      } catch (err) {
        if (requestedKind === 'sqlite') throw err
        log(`spawner data: node:sqlite unavailable (${err.message}) — falling back to ${jsonPath}`)
      }
    }
    backend = { kind: 'json', runs: readJson(), path: jsonPath }
    return backend
  }

  function insertRun (record) {
    const b = ensure()
    const row = normalizeRun(record)
    if (b.kind === 'sqlite') {
      const stmt = b.db.prepare(`INSERT INTO ${RUNS_TABLE} (
        bot, started_at, finished_at, interval_ms, balance_start, balance_end, earned,
        earned_per_hour, bot_x, bot_y, bot_z, bot_dimension, spawner_count, spawners, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      const info = stmt.run(
        row.bot, row.startedAt, row.finishedAt, row.intervalMs, row.balanceStart, row.balanceEnd,
        row.earned, row.earnedPerHour,
        row.botPosition ? row.botPosition.x : null,
        row.botPosition ? row.botPosition.y : null,
        row.botPosition ? row.botPosition.z : null,
        row.botPosition ? row.botPosition.dimension : null,
        row.spawnerCount, JSON.stringify(row.spawners), row.createdAt
      )
      row.id = Number(info.lastInsertRowid)
    } else {
      row.id = (b.runs[b.runs.length - 1]?.id || 0) + 1
      b.runs.push(row)
      if (b.runs.length > MAX_JSON_RUNS) b.runs.splice(0, b.runs.length - MAX_JSON_RUNS)
      writeJson(b.runs)
    }
    return row
  }

  function rowToRun (row) {
    return {
      id: Number(row.id),
      bot: row.bot,
      startedAt: Number(row.started_at),
      finishedAt: Number(row.finished_at),
      intervalMs: row.interval_ms === null ? null : Number(row.interval_ms),
      balanceStart: row.balance_start === null ? null : Number(row.balance_start),
      balanceEnd: row.balance_end === null ? null : Number(row.balance_end),
      earned: row.earned === null ? null : Number(row.earned),
      earnedPerHour: row.earned_per_hour === null ? null : Number(row.earned_per_hour),
      botPosition: row.bot_x === null
        ? null
        : { x: Number(row.bot_x), y: Number(row.bot_y), z: Number(row.bot_z), dimension: row.bot_dimension },
      spawnerCount: Number(row.spawner_count) || 0,
      spawners: safeParseArray(row.spawners),
      createdAt: Number(row.created_at)
    }
  }

  function safeParseArray (value) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch (_) { return [] }
  }

  // Every stored run, newest first. `bot` narrows it to one bot; `limit` caps it.
  function listRuns ({ bot, limit = 200 } = {}) {
    const b = ensure()
    if (b.kind === 'sqlite') {
      const sql = bot
        ? `SELECT * FROM ${RUNS_TABLE} WHERE bot = ? ORDER BY finished_at DESC LIMIT ?`
        : `SELECT * FROM ${RUNS_TABLE} ORDER BY finished_at DESC LIMIT ?`
      const rows = bot ? b.db.prepare(sql).all(bot, limit) : b.db.prepare(sql).all(limit)
      return rows.map(rowToRun)
    }
    const runs = bot ? b.runs.filter(r => r.bot === bot) : b.runs.slice()
    runs.sort((a, z) => z.finishedAt - a.finishedAt)
    return runs.slice(0, limit)
  }

  // Newest stored run per bot — used for the "current snapshot" rows.
  function latestRunPerBot () {
    const b = ensure()
    if (b.kind === 'sqlite') {
      const rows = b.db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE id IN (
        SELECT MAX(id) FROM ${RUNS_TABLE} GROUP BY bot
      ) ORDER BY bot`).all()
      return rows.map(rowToRun)
    }
    const byBot = new Map()
    for (const run of b.runs) {
      const current = byBot.get(run.bot)
      if (!current || run.finishedAt >= current.finishedAt) byBot.set(run.bot, run)
    }
    return [...byBot.values()].sort((a, z) => a.bot.localeCompare(z.bot))
  }

  function finishedAtFor (bot) {
    const runs = listRuns({ bot, limit: 1 })
    return runs.length ? runs[0].finishedAt : null
  }

  function totals () {
    const runs = listRuns({ limit: MAX_JSON_RUNS })
    const byBot = {}
    let earned = 0
    let spawners = 0
    for (const run of runs) {
      const entry = byBot[run.bot] || (byBot[run.bot] = {
        bot: run.bot, runs: 0, earned: 0, spawners: 0,
        firstRunAt: run.finishedAt, lastRunAt: run.finishedAt,
        lastEarned: null, lastEarnedPerHour: null
      })
      entry.runs++
      if (isNum(run.earned)) { entry.earned = round2(entry.earned + run.earned); earned = round2(earned + run.earned) }
      entry.spawners += run.spawnerCount
      spawners += run.spawnerCount
      entry.firstRunAt = Math.min(entry.firstRunAt, run.finishedAt)
      if (run.finishedAt > entry.lastRunAt || entry.lastEarned === null) {
        entry.lastRunAt = run.finishedAt
        entry.lastEarned = run.earned
        entry.lastEarnedPerHour = run.earnedPerHour
      }
    }
    return { overall: { bots: Object.keys(byBot).length, runs: runs.length, spawners, earned }, byBot }
  }

  function backendKind () {
    return ensure().kind
  }

  // Local JSON backup of the compiled snapshot (/data writes one on every run).
  function writeSnapshotFile (payload) {
    const b = ensure()
    const target = path.join(baseDir, SNAPSHOT_FILE)
    const tmp = target + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2))
    fs.renameSync(tmp, target)
    return { path: target, backend: b.kind }
  }

  function close () {
    if (backend?.kind === 'sqlite') { try { backend.db.close() } catch (_) {} }
    backend = null
  }

  return {
    dir: baseDir,
    sqlitePath,
    jsonPath,
    insertRun,
    listRuns,
    latestRunPerBot,
    finishedAtFor,
    totals,
    backendKind,
    writeSnapshotFile,
    close
  }
}

// ── Snapshot for the sheet ──────────────────────────────────────────────────
// One current row per bot/spawner (the run each bot most recently finished),
// the per-bot live stats (rank/coins/shards/balance from /data), and the
// lifetime totals. `mode: 'replace'` tells the Apps Script to overwrite the
// previous snapshot instead of appending.
function buildSpawnerSnapshot ({ runs = [], liveStats = [], totals = null, generatedAt = Date.now() } = {}) {
  const statsByBot = new Map()
  for (const stat of liveStats) statsByBot.set(stat.bot, stat)

  const spawnerRows = []
  const botRows = []
  const seenBots = new Set()

  for (const run of runs) {
    seenBots.add(run.bot)
    const stat = statsByBot.get(run.bot) || {}
    const intervalHours = isNum(run.intervalMs) && run.intervalMs > 0 ? run.intervalMs / 3600000 : null
    for (const spawner of run.spawners) {
      spawnerRows.push({
        bot: run.bot,
        spawner: spawner.label || `Spawner ${spawner.index}`,
        x: spawner.x,
        y: spawner.y,
        z: spawner.z,
        block: spawner.block || null,
        earned: isNum(spawner.earned) ? spawner.earned : null,
        earnedPerHour: (isNum(spawner.earned) && intervalHours) ? round2(spawner.earned / intervalHours) : null,
        balanceBefore: spawner.balanceBefore ?? null,
        balanceAfter: spawner.balanceAfter ?? null,
        status: spawner.status || 'ok',
        botX: run.botPosition ? run.botPosition.x : null,
        botY: run.botPosition ? run.botPosition.y : null,
        botZ: run.botPosition ? run.botPosition.z : null,
        dimension: run.botPosition ? run.botPosition.dimension : null,
        lastRunAt: run.finishedAt
      })
    }
    botRows.push({
      bot: run.bot,
      online: stat.online ?? null,
      rank: stat.rank ?? 'N/A',
      coins: stat.coins ?? null,
      shards: stat.shards ?? null,
      balance: isNum(stat.balance) ? stat.balance : run.balanceEnd,
      lifetimeEarned: totals?.byBot?.[run.bot]?.earned ?? null,
      lifetimeRuns: totals?.byBot?.[run.bot]?.runs ?? null,
      lastRunAt: run.finishedAt,
      lastIntervalMs: run.intervalMs,
      lastEarned: run.earned,
      lastEarnedPerHour: run.earnedPerHour,
      spawners: run.spawnerCount,
      botX: run.botPosition ? run.botPosition.x : null,
      botY: run.botPosition ? run.botPosition.y : null,
      botZ: run.botPosition ? run.botPosition.z : null,
      dimension: run.botPosition ? run.botPosition.dimension : null
    })
  }

  // Bots /data has live stats for but that have never run /spawners yet.
  for (const stat of liveStats) {
    if (seenBots.has(stat.bot)) continue
    botRows.push({
      bot: stat.bot,
      online: stat.online ?? null,
      rank: stat.rank ?? 'N/A',
      coins: stat.coins ?? null,
      shards: stat.shards ?? null,
      balance: isNum(stat.balance) ? stat.balance : null,
      lifetimeEarned: totals?.byBot?.[stat.bot]?.earned ?? null,
      lifetimeRuns: totals?.byBot?.[stat.bot]?.runs ?? null,
      lastRunAt: null,
      lastIntervalMs: null,
      lastEarned: null,
      lastEarnedPerHour: null,
      spawners: 0,
      botX: stat.botPosition ? stat.botPosition.x : null,
      botY: stat.botPosition ? stat.botPosition.y : null,
      botZ: stat.botPosition ? stat.botPosition.z : null,
      dimension: stat.botPosition ? stat.botPosition.dimension : null
    })
  }

  botRows.sort((a, z) => String(a.bot).localeCompare(String(z.bot)))
  const totalsRows = Object.values(totals?.byBot || {})
    .sort((a, z) => String(a.bot).localeCompare(String(z.bot)))
    .map(entry => ({
      bot: entry.bot,
      runs: entry.runs,
      spawners: entry.spawners,
      earned: entry.earned,
      lastEarned: entry.lastEarned,
      lastEarnedPerHour: entry.lastEarnedPerHour,
      firstRunAt: entry.firstRunAt,
      lastRunAt: entry.lastRunAt
    }))

  return {
    type: 'spawner-production-snapshot',
    version: 1,
    mode: 'replace',
    generatedAt,
    generatedAtIso: new Date(generatedAt).toISOString(),
    store: 'spawner_runs',
    totals: totals?.overall || { bots: 0, runs: 0, spawners: 0, earned: 0 },
    bots: botRows,
    spawners: spawnerRows,
    totalsByBot: totalsRows,
    sheetTabs: buildSheetTabs({ botRows, spawnerRows, totalsRows, totals: totals?.overall })
  }
}

// Ready-to-write tabs so the Apps Script only has to call setValues().
function buildSheetTabs ({ botRows, spawnerRows, totalsRows, totals }) {
  const botHeader = ['Bot', 'Online', 'Rank', 'Coins', 'Shards', 'Balance', 'Lifetime $', 'Lifetime Runs', 'Last Run', 'Interval (min)', 'Last $', '$/hour', 'Spawners In Reach', 'Bot X', 'Bot Y', 'Bot Z', 'Dimension']
  const spawnerHeader = ['Bot', 'Spawner', 'X', 'Y', 'Z', 'Block', '$ Earned', '$/hour', 'Balance Before', 'Balance After', 'Status', 'Bot X', 'Bot Y', 'Bot Z', 'Dimension', 'Last Run']
  const totalsHeader = ['Bot', 'Runs', 'Spawners Clicked', 'Lifetime $', 'Last $', 'Last $/hour', 'First Run', 'Last Run']
  return {
    Bots: {
      header: botHeader,
      rows: botRows.map(b => [b.bot, b.online === null ? 'N/A' : (b.online ? 'online' : 'offline'), b.rank, b.coins, b.shards, b.balance, b.lifetimeEarned, b.lifetimeRuns, isoOrEmpty(b.lastRunAt), b.lastIntervalMs === null ? '' : Math.round(b.lastIntervalMs / 60000), b.lastEarned, b.lastEarnedPerHour, b.spawners, b.botX, b.botY, b.botZ, b.dimension])
    },
    Spawners: {
      header: spawnerHeader,
      rows: spawnerRows.map(s => [s.bot, s.spawner, s.x, s.y, s.z, s.block, s.earned, s.earnedPerHour, s.balanceBefore, s.balanceAfter, s.status, s.botX, s.botY, s.botZ, s.dimension, isoOrEmpty(s.lastRunAt)])
    },
    Totals: {
      header: totalsHeader,
      rows: totalsRows.map(t => [t.bot, t.runs, t.spawners, t.earned, t.lastEarned, t.lastEarnedPerHour, isoOrEmpty(t.firstRunAt), isoOrEmpty(t.lastRunAt)]),
      summary: totals || { bots: 0, runs: 0, spawners: 0, earned: 0 }
    }
  }
}

function isoOrEmpty (ms) {
  return isNum(ms) ? new Date(ms).toISOString() : ''
}

// ── Google Sheets push (Apps Script webhook) ────────────────────────────────
// A plain POST of the snapshot JSON; the Apps Script writes it with
// SpreadsheetApp and answers with JSON. Apps Script replies with a 302 hop to
// googleusercontent.com, so any 2xx/3xx counts as delivered and the response
// body is best-effort.
async function pushSpawnerSnapshot (url, payload, { token, timeoutMs = 20000 } = {}) {
  if (!url) return { ok: false, error: 'no webhook url configured' }
  if (typeof fetch !== 'function') return { ok: false, error: 'global fetch unavailable (Node 18+ required)' }
  const body = token ? { ...payload, token } : payload
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['X-Auth-Token'] = token
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await res.text().catch(() => '')
    if (!res.ok && res.status >= 400) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` }
    }
    return { ok: true, status: res.status, response: text.slice(0, 400) }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

module.exports = {
  createSpawnerDataStore,
  buildSpawnerSnapshot,
  pushSpawnerSnapshot,
  computeEarnedPerHour,
  formatMoney,
  formatInterval,
  round2,
  RUNS_TABLE,
  MAX_JSON_RUNS
}
