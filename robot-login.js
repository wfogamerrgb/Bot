'use strict'

const fs = require('fs')
const path = require('path')
const { shuffledCopy, classifyAuthReply, readDelayMs } = require('./bot-controls')
const keyOf = name => String(name).toLowerCase()
const validName = name => /^[a-zA-Z0-9_]{1,16}$/.test(name)
const namesFromText = text => String(text).split(/\r?\n/).map(line => line.split('#')[0].trim().split(/\s+/)[0]).filter(Boolean)

// Unlike roster groups, admission routes need only a valid HOST/PORT/TYPE:
// an empty _BOTS list (or a gap in group numbers) must not hide a usable route.
function admissionRoutes(env) {
  const indexes = [...new Set(Object.keys(env).map(k => k.match(/^PROXY_GROUP_(\d+)_HOST$/)?.[1]).filter(Boolean))].map(Number).sort((a, b) => a - b)
  return [null, ...indexes.map(index => {
    const prefix = `PROXY_GROUP_${index}_`
    const host = String(env[prefix + 'HOST'] || '').trim()
    const port = Number(env[prefix + 'PORT'] || 1080)
    const type = String(env[prefix + 'TYPE'] || 'socks5').toLowerCase()
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !['socks5', 'http'].includes(type)) return null
    return { index, host, port, type, user: env[prefix + 'USER'] || '', pass: env[prefix + 'PASS'] ?? env[prefix + 'PASSWORD'] ?? '' }
  }).filter(Boolean)]
}

function createRobotLogin({ env = () => process.env, directory = __dirname, io = fs, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, random = Math.random, roster = () => [], existing = () => [], blocked = () => false, connect, close, send, log = () => {}, isPlayerChat = () => false, onAuthenticated = () => {} }) {
  const states = new Map()
  const persistedFailures = new Set()
  const failed = new Set() // fail closed even if disk is temporarily unwritable
  let queue = []
  let timer = null
  let routeIndex = 0
  let lastAttempt = null
  let running = false
  const file = name => path.join(directory, name)
  function read(name, optional = false) {
    try { return io.readFileSync(file(name), 'utf8') } catch (err) {
      if (optional && err.code === 'ENOENT') return ''
      throw err
    }
  }
  function removed() { return new Set(namesFromText(read('removed.txt', true)).map(keyOf)) }
  function state(name) { return states.get(keyOf(name)) }
  function cleanReason(reason) {
    let text = String(reason || 'Admission failed').replace(/[\r\n\t]/g, ' ')
    for (const s of states.values()) for (const password of s.passwords) if (password) text = text.split(password).join('[redacted]')
    return text.slice(0, 500)
  }
  function cancelAuth(s) {
    if (s.authTimer) clearTimer(s.authTimer)
    s.authTimer = null
    s.scheduled = false
  }
  function fail(name, reason) {
    const s = state(name)
    if (!s || s.phase !== 'admitting') return false
    s.phase = 'blocked'
    cancelAuth(s)
    if (s.timeout) clearTimer(s.timeout)
    failed.add(keyOf(name))
    const safe = cleanReason(reason)
    try {
      const text = read('removed.txt', true)
      if (!namesFromText(text).some(n => keyOf(n) === keyOf(name))) {
        io.appendFileSync(file('removed.txt'), `${text && !text.endsWith('\n') ? '\n' : ''}${s.name}\t# ${new Date(now()).toISOString()} ${safe}\n`)
      }
      persistedFailures.add(keyOf(name))
    } catch (err) { log(`Cannot write removed.txt; ${s.name} remains blocked in memory (${err.code || 'I/O error'}).`) }
    close(s.name)
    log(`${s.name}: admission closed; removed.txt — ${safe}`)
    return true
  }
  function complete(s) {
    if (s.authenticated && s.setupReady && s.phase === 'admitting') {
      s.phase = 'admitted'
      cancelAuth(s)
      clearTimer(s.timeout)
      log(`${s.name}: login and normal AFK setup completed.`)
    }
  }
  function setupReady(name) { const s = state(name); if (s) { s.setupReady = true; complete(s) } }
  function schedulePassword(s, kind, delay) {
    if (s.scheduled) return
    s.kind = kind
    s.scheduled = true
    s.authTimer = setTimer(() => {
      s.scheduled = false
      s.authTimer = null
      if (s.phase === 'blocked' || s.authenticated) return
      const password = s.passwords[s.passwordIndex]
      if (!password) { fail(s.name, 'No login password configured'); return }
      s.sentAt = now()
      try { send(s.name, kind === 'register' ? `/register ${password} ${password}` : `/login ${password}`) } catch (_) { fail(s.name, 'Failed to send authentication command') }
    }, delay)
  }
  function onMessage(name, message) {
    const s = state(name)
    if (!s || s.phase !== 'admitting' || isPlayerChat(message)) return false
    const text = String(message).replace(/\u00a7./g, '')
    if (/already\s+(?:connected|online)|logged\s+in\s+(?:from|on)\s+another/i.test(text) && s.phase === 'admitting') { fail(name, 'Server rejected duplicate connection'); return true }
    // "Already logged in" alone can refer to this session; never advance a
    // candidate on it, and conservatively close during admission.
    const reply = classifyAuthReply(text)
    // A throttle can arrive during the fallback wait, when sentAt has already
    // been cleared. It still cancels admission immediately, never sends the
    // queued candidate into a rate limit. Same for duplicate-session replies.
    if (reply && ['throttled', 'already'].includes(reply.kind)) { fail(name, `Authentication ${reply.kind}`); return true }
    const verdict = s.sentAt != null && now() - s.sentAt <= readDelayMs(env().AUTH_REPLY_WINDOW_MS, 30000) ? reply : null
    if (verdict) {
      s.sentAt = null
      if (s.phase !== 'admitting') return false // ordinary guard after admission
      if (verdict.kind === 'bad-password' && s.passwordIndex + 1 < s.passwords.length) {
        s.passwordIndex++
        cancelAuth(s)
        schedulePassword(s, s.kind || 'login', readDelayMs(env().ROBOT_PASSWORD_DELAY_MS, 1500))
        log(`${s.name}: password rejected; trying candidate ${s.passwordIndex + 1} after the configured delay.`)
      } else fail(name, verdict.kind === 'bad-password' ? 'All configured login passwords rejected' : `Authentication ${verdict.kind}`)
      return true
    }
    if (/\b(?:successfully\s+(?:logged\s*in|registered|authenticated)|(?:login|authentication|registration)\s+(?:successful|success)|(?:logged\s*in|registered)\s+successfully)\b/i.test(text)) {
      const firstSuccess = !s.authenticated
      s.authenticated = true
      s.sentAt = null
      cancelAuth(s)
      if (firstSuccess) onAuthenticated(s.name)
      complete(s)
      return true
    }
    const kind = /\/register\b/i.test(text) ? 'register' : /\/login\b/i.test(text) ? 'login' : null
    if (!kind) return s.phase === 'admitting'
    if (!s.authenticated && !s.scheduled && s.sentAt == null) schedulePassword(s, kind, 250)
    return true
  }
  function rememberedPassword(name) {
    const s = state(name)
    if (s?.phase !== 'admitted') return null
    // A live edit of the candidate key should reach the next authentication,
    // but a successful fallback stays the selected key rather than reverting
    // to the rejected primary on every ordinary reconnect.
    return env()[s.passwordKeys[s.passwordIndex]] || s.passwords[s.passwordIndex]
  }
  function reconnect(name) {
    const s = state(name)
    if (!s || s.phase !== 'admitted') return
    cancelAuth(s)
    s.authenticated = false
    s.sentAt = null
  }
  function route(name) {
    const s = state(name)
    if (!s) return undefined // undefined = ordinary roster route; null = direct
    if (s.route == null) return null
    return admissionRoutes(env()).find(r => r?.index === s.route) || null
  }
  function eligible(name, removedNames) {
    const key = keyOf(name)
    return validName(name) && !failed.has(key) && !removedNames.has(key) && !blocked(name) && ![...roster(), ...existing()].some(n => keyOf(n) === key)
  }
  function tick() {
    timer = null
    if (!running) return
    try {
      const removedNames = removed()
      while (queue.length) {
        const name = queue.shift()
        if (!eligible(name, removedNames)) { log(`${name}: skipped (duplicate, removed, or invalid username).`); continue }
        const gap = readDelayMs(env().ROBOT_CONNECT_DELAY_MS, 5000)
        if (lastAttempt != null && now() - lastAttempt < gap) {
          queue.unshift(name)
          timer = setTimer(tick, gap - (now() - lastAttempt))
          return
        }
        const routes = admissionRoutes(env())
        const chosen = routes[routeIndex++ % routes.length]
        const passwordKeys = []
        const passwords = []
        for (const key of ['LOGIN_PASSWORD', 'LOGIN_PASSWORD_1', 'LOGIN_PASSWORD_2']) {
          const value = env()[key]
          if (typeof value === 'string' && value.length && !passwords.includes(value)) { passwords.push(value); passwordKeys.push(key) }
        }
        const s = { name, phase: 'admitting', route: chosen?.index ?? null, passwords, passwordKeys, passwordIndex: 0, authenticated: false, setupReady: false, sentAt: null, scheduled: false }
        states.set(keyOf(name), s)
        lastAttempt = now()
        if (!passwords.length) { fail(name, 'No login password configured'); continue }
        s.timeout = setTimer(() => fail(name, 'Login/setup admission timed out'), readDelayMs(env().ROBOT_ADMISSION_TIMEOUT_MS, 180000))
        log(`${name}: admitting via ${chosen ? `proxy group ${chosen.index}` : 'direct'}.`)
        try { if (!connect(name)) fail(name, 'Connection creation failed') } catch (_) { fail(name, 'Connection creation failed') }
        // Skips do not consume a route slot or admission delay. Only actual
        // connection attempts do. tick immediately examines the next name.
      }
      running = false
      log('robot.txt connection-attempt queue finished; in-flight logins continue.')
    } catch (err) { running = false; log(`Login queue stopped: cannot read account files (${err.code || 'I/O error'}).`) }
  }
  function start({ retry = null } = {}) {
    if (running) return { ok: false, error: 'Login queue already running' }
    try {
      if (retry) {
        if (!validName(retry)) return { ok: false, error: 'Invalid retry username' }
        if ([...roster(), ...existing()].some(n => keyOf(n) === keyOf(retry))) return { ok: false, error: 'Retry target already belongs to the roster' }
        const text = read('removed.txt', true)
        io.writeFileSync(file('removed.txt'), text.split(/\r?\n/).filter(line => keyOf(namesFromText(line)[0] || '') !== keyOf(retry)).join('\n'))
        failed.delete(keyOf(retry))
        queue = [retry]
      } else {
        const text = read('robot.txt')
        const unique = new Map(namesFromText(text).map(n => [keyOf(n), n]))
        // Removing a line by hand explicitly restores a persisted failure.
        const removedNames = removed()
        for (const key of persistedFailures) if (!removedNames.has(key)) { failed.delete(key); persistedFailures.delete(key) }
        queue = shuffledCopy([...unique.values()], random)
      }
      running = true
      routeIndex = 0
      tick()
      return { ok: true }
    } catch (err) { return { ok: false, error: `Cannot read robot.txt/removed.txt (${err.code || 'I/O error'})` } }
  }
  function stop() { running = false; queue = []; if (timer) clearTimer(timer); timer = null }
  return { start, stop, state, fail, route, setupReady, onMessage, reconnect, rememberedPassword, pending: () => running, isAdmitting: name => state(name)?.phase === 'admitting' }
}
module.exports = { createRobotLogin, admissionRoutes, namesFromText }
