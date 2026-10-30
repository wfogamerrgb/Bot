'use strict'
// Direct-route pool — the bots that are NOT in a proxy group.
//
// The fleet is deliberately split: three proxy groups of ten ride their own Tor
// instance, and everything else connects direct. Direct is cheap but it shares
// one IP, so the whole cohort is banned together when that IP is flagged. Two
// things have to work there and neither existed:
//
//   1. A CEILING. Only DIRECT_MAX (default 20) direct bots run at once, even if
//      the roster lists a hundred of them — otherwise BOT_MAX alone decides and
//      every spare name hammers the same IP.
//   2. A REPLACEMENT. When a direct bot is banned, the next unused direct name
//      from the roster takes the free slot, so the cohort keeps its size
//      instead of shrinking to nothing one ban at a time.
//
// The pool is a pure function of config + rows: no timers, no I/O. bot.js owns
// connecting and logging; this module owns the decision, which is what the tests
// below can pin down.

/** Names listed in every PROXY_GROUP_<n>_BOTS, lowercased. */
function groupedNames (config) {
  const out = new Set()
  for (const [key, value] of Object.entries(config || {})) {
    if (!/^PROXY_GROUP_\d+_BOTS$/.test(key)) continue
    for (const name of splitList(value)) out.add(name.toLowerCase())
  }
  return out
}

/** Local copy of the roster splitter so this module stays dependency-free. */
function splitList (value) {
  return String(value == null ? '' : value)
    .split(/[\s,;]+/)
    .map(name => name.trim())
    .filter(Boolean)
}

/**
 * Is this bot on the direct route? `BOT_DIRECT_<name>=true` forces direct (that
 * is how /new-gen routes a name past a global PROXY_HOST), and any name absent
 * from every proxy group is direct by definition — the same rule bot.js applies
 * when it resolves a connection's proxy.
 */
function isDirectRoute (name, config, explicitDirect = false) {
  const id = String(name || '').trim()
  if (!id) return false
  if (explicitDirect || (config || {})[`BOT_DIRECT_${id}`] === 'true') return true
  for (const [key, value] of Object.entries(config || {})) {
    const match = key.match(/^PROXY_GROUP_(\d+)_BOTS$/)
    if (!match || !splitList(value).some(n => n.toLowerCase() === id.toLowerCase())) continue
    return !String(config[`PROXY_GROUP_${match[1]}_HOST`] || config.PROXY_HOST || '').trim()
  }
  return !String((config || {}).PROXY_HOST || '').trim()
}

/** The direct roster, in BOT_NAMES order — stable across restarts. */
function directPool (config) {
  const seen = new Set()
  const out = []
  for (const name of splitList((config || {}).BOT_NAMES)) {
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (isDirectRoute(name, config)) out.push(name)
  }
  return out
}

/**
 * Row lookup: id → { online, banned, connecting, removed }.
 * `rows` is what bot.js already builds for the dashboard (botSnapshot).
 */
function rowMap (rows) {
  const map = new Map()
  for (const row of rows || []) {
    if (!row || !row.id) continue
    map.set(String(row.id).toLowerCase(), row)
  }
  return map
}

/**
 * Everything the dashboard and the watchdog need to know about the direct route.
 *
 *   limit      DIRECT_MAX
 *   pool       roster names on the direct route
 *   live       pool names occupying a connection slot (online or connecting)
 *   connected  pool names that are online
 *   banned     pool names with an active ban / on the removed list
 *   usable     pool names that are neither banned nor removed
 *   freeSlots  how many more direct connections may start
 *   allBanned  TRUE only when the pool is non-empty and every name is banned —
 *              the route is dead, not merely short of bots
 *
 * The ceiling counts LIVE connections, never roster entries: a banned bot keeps
 * its entry but not its connection, and its replacement has to be allowed to
 * take the freed slot.
 */
function directStatus ({ config = {}, rows = [], limit = 20, banned = () => false, removed = () => false } = {}) {
  const pool = directPool(config)
  const map = rowMap(rows)
  const ceiling = Math.max(0, Number(limit) || 0)
  let live = 0
  let connected = 0
  let bannedCount = 0
  let usable = 0
  for (const name of pool) {
    const key = name.toLowerCase()
    const row = map.get(key)
    const isBanned = Boolean(banned(name)) || Boolean(row && row.banned)
    const isRemoved = Boolean(removed(name)) || Boolean(row && row.removed)
    const isOnline = Boolean(row && row.online)
    if (isOnline) connected++
    if (isBanned || isRemoved) bannedCount++
    if (!isBanned && !isRemoved) usable++
  }
  // Include active direct admissions and generated accounts outside BOT_NAMES.
  // A blocked/disconnected roster entry does not reserve a connection slot.
  for (const row of map.values()) {
    if (!(row.direct === undefined ? isDirectRoute(row.id, config) : row.direct) || row.banned || row.removed) continue
    if (row.online || row.connecting) live++
  }
  return {
    limit: ceiling,
    poolSize: pool.length,
    live,
    connected,
    banned: bannedCount,
    usable,
    freeSlots: Math.max(0, ceiling - live),
    allBanned: pool.length > 0 && usable === 0,
    pool
  }
}

/**
 * May this name start a connection right now? Existing entries may always
 * reconnect (a dropped socket is not a new bot); new direct names only while
 * the direct ceiling has room.
 */
function mayConnectDirect ({ name, config = {}, rows = [], limit = 20, routeIsDirect } = {}) {
  if (routeIsDirect === false || (routeIsDirect !== true && !isDirectRoute(name, config))) return { ok: true, direct: false }
  const map = rowMap(rows)
  const existing = map.get(String(name).toLowerCase())
  if (existing && (existing.online || existing.connecting)) return { ok: true, direct: true, existing: true }
  const status = directStatus({ config, rows, limit })
  if (status.live >= status.limit) {
    return { ok: false, direct: true, error: `DIRECT_MAX=${status.limit} reached (${status.live} direct connections)`, status }
  }
  return { ok: true, direct: true, status }
}

/**
 * The next unused direct name to take a freed slot: roster order, skipping
 * anything already known, banned or removed. `blocked` is a Set of lowercased
 * names the caller must not touch (removed list, deathbans, an in-flight
 * connect).
 */
function nextDirectCandidate ({ config = {}, rows = [], blocked = [] } = {}) {
  const map = rowMap(rows)
  const skip = new Set([...blocked].map(name => String(name).toLowerCase()))
  for (const name of directPool(config)) {
    const key = name.toLowerCase()
    if (map.has(key) || skip.has(key)) continue
    return name
  }
  return null
}

module.exports = { groupedNames, splitList, isDirectRoute, directPool, directStatus, mayConnectDirect, nextDirectCandidate }
