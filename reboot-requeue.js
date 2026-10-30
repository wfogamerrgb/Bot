'use strict'
// ── Reboot-aware re-queue onto lifesteal ─────────────────────────────────────
// The server announces a restart in chat:
//
//   ⚠ Server Reboot
//   The server will be rebooting soon
//   you will be returned automatically
//   ↓ Reboot Time ↓
//   ♦ Happening In: 1s
//
// …and then drops the connection. Firing /server lifesteal the moment the
// socket is back (the normal 3-5s startup send) lands in the window where the
// proxy rejects the transfer ("Please wait … try again"), so the bot sits on
// the hub until the 10-minute chat watchdog notices. This module owns that
// window instead:
//
//   1. ARM      — the reboot announcement is seen in chat.
//   2. WAIT     — do nothing while the server is down. A 'configuration' state
//                 (the restart / transfer handshake) re-arms the wait.
//   3. SETTLE   — the first 'play' state after the announcement starts the
//                 settle timer (REBOOT_REQUEUE_DELAY_MS, default 10 s).
//   4. REQUEST  — send the server command (default /server lifesteal).
//   5. VERIFY   — SUCCESS is the 'configuration' state arriving after the
//                 command: that handshake is the proxy actually moving us to
//                 the lifesteal backend. Nothing else counts.
//   6. RETRY    — a "Please wait" / "try again" reply (or no handshake at all)
//                 re-sends after REBOOT_REQUEUE_RETRY_MS, up to
//                 REBOOT_REQUEUE_MAX_ATTEMPTS, then gives up loudly.
//
// It is inert unless armed: no announcement, no behaviour change. The bot is
// never sent anywhere it was not already going.

const DEFAULTS = {
  enabled: true,
  delayMs: 10000,     // settle time after the server is back in 'play'
  retryMs: 5000,      // gap between attempts
  maxAttempts: 10,
  ttlMs: 600000,      // stop waiting after 10 minutes if the reboot never happens
  command: null,      // falls back to SERVER_COMMAND || '/server lifesteal'
}

// The announcement itself. Kept loose: different proxies word the second line
// differently, but they all say "server reboot" or "rebooting soon".
const REBOOT_RE = /server\s+reboot|rebooting\s+soon|be\s+returned\s+automatically|reboot\s+time|happening\s+in:/i
// Replies that mean "not yet" rather than "wrong command".
const RETRY_RE = /please\s+wait|try\s+again|too\s+many|be\s+patient|still\s+(?:restarting|rebooting)/i

function readConfig (env) {
  const num = (name, def) => {
    const raw = env?.[name]
    if (raw == null || raw === '') return def
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : def
  }
  const bool = (name, def) => {
    const raw = env?.[name]
    if (raw == null || raw === '') return def
    return !/^(?:0|false|no|off)$/i.test(String(raw).trim())
  }
  const command = env?.REBOOT_REQUEUE_COMMAND || env?.SERVER_COMMAND || '/server lifesteal'
  return {
    enabled: bool('REBOOT_REQUEUE_ENABLED', DEFAULTS.enabled),
    delayMs: num('REBOOT_REQUEUE_DELAY_MS', DEFAULTS.delayMs),
    retryMs: num('REBOOT_REQUEUE_RETRY_MS', DEFAULTS.retryMs),
    maxAttempts: Math.max(1, num('REBOOT_REQUEUE_MAX_ATTEMPTS', DEFAULTS.maxAttempts)),
    ttlMs: num('REBOOT_REQUEUE_TTL_MS', DEFAULTS.ttlMs),
    command,
  }
}

function createRebootRequeue (deps) {
  const {
    sendChat, log, now, setTimer, clearTimer, getEnv,
  } = deps || {}
  if (typeof sendChat !== 'function') throw new Error('reboot-requeue: sendChat dependency is required')
  if (typeof now !== 'function') throw new Error('reboot-requeue: now dependency is required')
  if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new Error('reboot-requeue: setTimer/clearTimer dependencies are required')
  }

  const cfg = () => readConfig(typeof getEnv === 'function' ? getEnv() : process.env)
  const say = (id, msg) => { try { log?.(id, msg) } catch (_) {} }

  // id -> { phase, armedAt, sawPlayAt, attempts, timer, doneReason }
  // phase: 'waiting' (reboot in progress) → 'settling' (counting down) →
  //        'requested' (command sent, waiting for the handshake) → 'done'
  const states = new Map()

  function stateFor (id) {
    let s = states.get(id)
    if (!s) {
      s = { phase: 'idle', armedAt: 0, sawPlayAt: 0, attempts: 0, timer: null, lastReply: null }
      states.set(id, s)
    }
    return s
  }

  function clear (s) {
    if (s.timer) { try { clearTimer(s.timer) } catch (_) {} s.timer = null }
  }

  function schedule (id, s, ms, fn) {
    clear(s)
    s.timer = setTimer(() => {
      s.timer = null
      try { fn() } catch (_) {}
    }, ms)
    return s.timer
  }

  function isArmed (id) {
    const s = states.get(id)
    return !!s && (s.phase === 'waiting' || s.phase === 'settling' || s.phase === 'requested')
  }

  function finish (id, s, reason) {
    clear(s)
    s.phase = 'done'
    s.doneReason = reason
    say(id, reason)
  }

  function request (id, s) {
    const c = cfg()
    if (!isArmed(id)) return
    if (s.attempts >= c.maxAttempts) {
      finish(id, s, `gave up after ${s.attempts} attempt(s); ${c.command} was not accepted`)
      return
    }
    s.attempts += 1
    s.phase = 'requested'
    const ok = sendChat(id, c.command) !== false
    say(id, ok
      ? `sending ${c.command} (attempt ${s.attempts}/${c.maxAttempts})`
      : `${c.command} could not be sent (bot offline?) — attempt ${s.attempts}/${c.maxAttempts}`)
    // Safety net: if neither the handshake nor a "please wait" reply arrives,
    // this is what makes the next attempt happen rather than hanging.
    schedule(id, s, c.retryMs, () => {
      if (s.phase !== 'requested') return
      say(id, `no handshake ${Math.round(c.retryMs / 1000)}s after ${c.command} — retrying`)
      request(id, s)
    })
  }

  /** Chat line from the server. Arm on the announcement, retry on "please wait". */
  function onChat (id, text) {
    const c = cfg()
    if (!c.enabled) return false
    const line = String(text == null ? '' : text)
    if (!line) return false
    const s = stateFor(id)

    if (REBOOT_RE.test(line)) {
      if (s.phase === 'requested') return false       // already waiting on the handshake
      const already = s.phase === 'waiting' || s.phase === 'settling'
      s.phase = 'waiting'
      s.sawPlayAt = 0
      if (!already) {
        s.armedAt = now()
        s.attempts = 0
        clear(s)
        say(id, `server reboot announced — waiting for it to come back, then ${Math.round(c.delayMs / 1000)}s before ${c.command}`)
        schedule(id, s, c.ttlMs, () => {
          if (s.phase === 'waiting' || s.phase === 'settling') {
            finish(id, s, 'no reboot happened within the TTL — standing down')
          }
        })
      }
      return true
    }

    if (s.phase === 'requested' && RETRY_RE.test(line)) {
      s.lastReply = line.slice(0, 80)
      say(id, `server said "${s.lastReply}" — retrying in ${Math.round(c.retryMs / 1000)}s`)
      schedule(id, s, c.retryMs, () => { if (s.phase === 'requested') request(id, s) })
      return true
    }

    return false
  }

  /**
   * Protocol state from the connection: 'configuration' | 'play' | 'status' | 'login'.
   * Returns true when this module consumed the transition.
   */
  function onState (id, newState) {
    const c = cfg()
    if (!c.enabled) return false
    const s = stateFor(id)
    if (s.phase === 'idle' || s.phase === 'done') return false

    if (newState === 'play') {
      if (s.phase === 'waiting') {
        s.phase = 'settling'
        s.sawPlayAt = now()
        say(id, `server is back — sending ${c.command} in ${Math.round(c.delayMs / 1000)}s`)
        schedule(id, s, c.delayMs, () => {
          if (s.phase === 'settling') request(id, s)
        })
        return true
      }
      return false
    }

    if (newState === 'configuration') {
      if (s.phase === 'requested') {
        // THE success condition: the proxy moves us to the backend by putting
        // the client back through the configuration phase (registry_data /
        // select_known_packs). Nothing else proves the transfer happened.
        finish(id, s, `${c.command} accepted — server sent the configuration handshake (transfer started)`)
        return true
      }
      if (s.phase === 'waiting' || s.phase === 'settling') {
        // Server going down, or the proxy bouncing us mid-settle: back to waiting.
        s.phase = 'waiting'
        s.sawPlayAt = 0
        clear(s)
        return true
      }
    }
    return false
  }

  /** True while bot.js should NOT fire its own generic startup/respawn server command. */
  function suppressesStartup (id) {
    return isArmed(id)
  }

  function status (id) {
    const s = states.get(id)
    if (!s) return { phase: 'idle' }
    return { phase: s.phase, attempts: s.attempts, sawPlayAt: s.sawPlayAt, lastReply: s.lastReply }
  }

  function reset (id) {
    const s = states.get(id)
    if (s) clear(s)
    states.delete(id)
  }

  function resetAll () {
    for (const id of [...states.keys()]) reset(id)
  }

  return { onChat, onState, isArmed, suppressesStartup, status, reset, resetAll, _config: cfg, _states: states }
}

module.exports = { createRebootRequeue, DEFAULTS, readConfig, REBOOT_RE, RETRY_RE }
