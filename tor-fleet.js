'use strict'
const net = require('node:net')
const { execFile } = require('node:child_process')
const { sendTorSignal } = require('./bot-controls')

// A configured SOCKS endpoint is the controllable unit, not a proof that Tor
// uses one exit for every destination. Never treat HTTP/remote proxies as Tor.
function torEndpoint(proxy) {
  if (!proxy || (proxy.type || 'socks5') !== 'socks5') return null
  const host = String(proxy.host || '').toLowerCase()
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return null
  const port = Number(proxy.port)
  if (!Number.isInteger(port) || port < 1 || port >= 65535) return null
  return { key: String(port), host, port, controlPort: port + 1 }
}
function readTorExitIp(proxy, { run = execFile } = {}) {
  return new Promise((resolve, reject) => {
    const host = proxy.host === '::1' ? '[::1]' : '127.0.0.1'
    run('curl', ['--silent', '--show-error', '--fail', '--max-time', '8', '--proto', '=https', '--socks5-hostname', `${host}:${proxy.port}`, 'https://api.ipify.org'], { timeout: 10000, maxBuffer: 1024 }, (error, stdout) => {
      if (error) { reject(new Error('SOCKS exit-IP probe failed (curl/network/Tor unavailable)')); return }
      const ip = String(stdout).trim()
      if (!net.isIP(ip)) { reject(new Error('SOCKS exit-IP probe did not return a valid IP')); return }
      resolve(ip)
    })
  })
}
async function verifyTorRotation(endpoint, { probe = readTorExitIp, signal = sendTorSignal, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 3, settleMs = 10000 } = {}) {
  try {
    // If the original IP is unknown, there is nothing to compare; do not signal
    // and then pretend the newly observed address is a proven change.
    const before = await probe(endpoint)
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = await signal(endpoint.controlPort)
      if (!result.ok) return { ok: false, error: result.error || 'Tor control rejected NEWNYM', before, attempt }
      // Tor may acknowledge a rate-limited NEWNYM before it takes effect.
      await wait(settleMs)
      const after = await probe(endpoint)
      if (after !== before) return { ok: true, before, after, attempt }
    }
    return { ok: false, before, error: `SOCKS probe exit IP unchanged after ${attempts} NEWNYM attempts` }
  } catch (error) { return { ok: false, error: error.message } }
}
// Ban-wave rotation for one local Tor endpoint. A wave is "every assigned bot
// confirmed banned and offline" (the classic case) OR more than a configurable
// share of them (default 80% — TOR_ROTATE_BAN_RATIO): by the time most of the
// fleet on one circuit is banned, that exit is flagged, and waiting for the
// last straggler just burns the remaining accounts too. `threshold` is a number
// or a live getter. `restart` (optional) is the escalation when SIGNAL NEWNYM
// cannot prove a changed exit: it restarts Tor itself and re-proves — the
// "make sure the circuit actually works" half of the contract.
function createAllBannedTorRotation({ snapshot, rotate = verifyTorRotation, restart, enabled = () => true, now = Date.now, cooldownMs = 300000, threshold = 0.8, log = () => {} }) {
  const states = new Map()
  function limit () {
    const value = typeof threshold === 'function' ? Number(threshold()) : Number(threshold)
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.8
  }
  function groups() {
    const result = new Map()
    for (const row of snapshot()) {
      const endpoint = torEndpoint(row.proxy)
      if (!endpoint) continue
      let group = result.get(endpoint.key)
      if (!group) { group = { endpoint, rows: new Map() }; result.set(endpoint.key, group) }
      group.rows.set(String(row.id).toLowerCase(), row)
    }
    return result
  }
  async function check() {
    if (!enabled()) return []
    const tasks = []
    const current = groups()
    for (const key of states.keys()) if (!current.has(key) && !states.get(key).pending) states.delete(key)
    for (const [key, group] of current) {
      const rows = [...group.rows.values()]
      const banned = rows.filter(row => row.banned && !row.online).length
      const share = rows.length ? banned / rows.length : 0
      // "all" stays its own clause so a threshold of 1.0 still fires on a
      // fully banned fleet; "more than the threshold" catches the wave early.
      const wave = rows.length > 0 && banned > 0 && (banned === rows.length || share > limit())
      const signature = rows.map(row => `${String(row.id).toLowerCase()}:${row.bannedAt || 0}`).sort().join('|')
      const state = states.get(key) || { pending: false, completed: null, lastAttempt: null }
      states.set(key, state)
      if (!wave) { state.completed = null; continue }
      if (state.pending || state.completed === signature || (state.lastAttempt != null && now() - state.lastAttempt < cooldownMs)) continue
      state.pending = true
      state.lastAttempt = now()
      log(banned === rows.length
        ? `All ${rows.length} assigned bots on Tor SOCKS :${group.endpoint.port} are confirmed banned; requesting a verified exit change. Banned accounts stay blocked.`
        : `${banned} of ${rows.length} assigned bots on Tor SOCKS :${group.endpoint.port} are confirmed banned (over the ${Math.round(limit() * 100)}% threshold); requesting a verified exit change. Banned accounts stay blocked.`)
      tasks.push((async () => {
        let result
        try { result = await rotate(group.endpoint) } catch (error) { result = { ok: false, error: error.message } }
        if (!result.ok && typeof restart === 'function') {
          log(`Tor SOCKS :${group.endpoint.port}: NEWNYM rotation not verified (${result.error}) — escalating to a full Tor restart.`)
          let restarted
          try { restarted = await restart(group.endpoint) } catch (error) { restarted = { ok: false, error: error.message } }
          result = restarted && restarted.ok
            ? { ok: true, before: restarted.before ?? result.before, after: restarted.after, restarted: true }
            : { ok: false, error: `${result.error}; Tor restart fallback failed: ${(restarted && restarted.error) || 'no result'}` }
        }
        state.pending = false
        if (result.ok) state.completed = signature
        log(result.ok
          ? (result.restarted
            ? `Tor SOCKS :${group.endpoint.port}: Tor restarted — probe exit ${result.before || '(previous unknown)'} → ${result.after}. Every circuit through this instance is new; account bans are not lifted and destination exits may differ.`
            : `Tor SOCKS :${group.endpoint.port}: probe exit changed ${result.before} → ${result.after}. Existing connections keep their circuits; account bans are not lifted and destination exits may differ.`)
          : `Tor SOCKS :${group.endpoint.port}: exit change NOT verified — ${result.error}. Will retry after cooldown.`)
        return { ...result, port: group.endpoint.port, bots: rows.map(row => row.id) }
      })())
    }
    return Promise.all(tasks)
  }
  return { check }
}
module.exports = { torEndpoint, readTorExitIp, verifyTorRotation, createAllBannedTorRotation }
