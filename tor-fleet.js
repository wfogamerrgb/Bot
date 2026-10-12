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
function createAllBannedTorRotation({ snapshot, rotate = verifyTorRotation, enabled = () => true, now = Date.now, cooldownMs = 300000, log = () => {} }) {
  const states = new Map()
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
      const allBanned = rows.length > 0 && rows.every(row => row.banned && !row.online)
      const signature = rows.map(row => `${String(row.id).toLowerCase()}:${row.bannedAt || 0}`).sort().join('|')
      const state = states.get(key) || { pending: false, completed: null, lastAttempt: null }
      states.set(key, state)
      if (!allBanned) { state.completed = null; continue }
      if (state.pending || state.completed === signature || (state.lastAttempt != null && now() - state.lastAttempt < cooldownMs)) continue
      state.pending = true
      state.lastAttempt = now()
      log(`All ${rows.length} assigned bots on Tor SOCKS :${group.endpoint.port} are confirmed banned; requesting a verified exit change. Banned accounts stay blocked.`)
      tasks.push((async () => {
        let result
        try { result = await rotate(group.endpoint) } catch (error) { result = { ok: false, error: error.message } }
        state.pending = false
        if (result.ok) state.completed = signature
        log(result.ok
          ? `Tor SOCKS :${group.endpoint.port}: probe exit changed ${result.before} → ${result.after}. Existing connections keep their circuits; account bans are not lifted and destination exits may differ.`
          : `Tor SOCKS :${group.endpoint.port}: exit change NOT verified — ${result.error}. Will retry after cooldown.`)
        return { ...result, port: group.endpoint.port, bots: rows.map(row => row.id) }
      })())
    }
    return Promise.all(tasks)
  }
  return { check }
}
module.exports = { torEndpoint, readTorExitIp, verifyTorRotation, createAllBannedTorRotation }
