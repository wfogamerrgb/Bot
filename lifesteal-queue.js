'use strict'
// ── Lifesteal queue / arena / TPA automation ─────────────────────────────────
// Roles (all distinct bots while running):
//   duels  — one random bot sends DUELSROOM_CMD (/duelsroomqueue). On death/
//            disconnect/kick a new random bot is picked (the dead bot is NOT
//            blacklisted, so the same name may be picked again — per request).
//   queue  — one random bot sends QUEUE_CMD (/queue), same replacement rule.
//   arena  — one random bot that is NOT duels/queue/tpa does
//            `/warp arena`, waits 5s, then holds forward until it hits
//            something (solid block ahead OR stuck in place). Then repeats.
//   tpa    — one bot spams `/tpa <player>` round-robin over every visible
//            player until deathban, then a fresh random bot takes over.
//   idle   — every other bot stays `/warp afk` (sent once, not spammed).
// How many bots hold each role is configuration, not a constant:
//   LIFESTEAL_DUELS_BOTS / LIFESTEAL_QUEUE_BOTS / LIFESTEAL_ARENA_BOTS /
//   LIFESTEAL_TPA_BOTS (default 1 each, 0 disables the role). Role holders
//   are always distinct bots; when the counts outnumber the fleet the later
//   roles go short rather than sharing a bot. Counts are reread every tick,
//   so lowering one releases the extra bots back to idle live.
//
// Standalone routines (no roster, no /new-gen, no Tor restart — just the
// routine on the bots that are already online):
//   /tpa-roundrobin [count]   /duelsroomspam [count]   /queuespam [count]
//   /warp-arena [count]       /afk-park [count]        …each with `stop`
// They run ONE role across up to [count] bots (default: every online bot) via
// startSolo(role, count); duels/queue re-send their command every
// SOLO_REPEAT_MS because a standalone "spam" is the whole point. A standalone
// routine and /lifesteal-start are mutually exclusive (both drive the same
// roles), and a standalone routine never creates or replaces accounts.
// Roster  — every ROSTER_TICK_MS the manager tops the fleet back up to
//            TARGET_BOTS (default 20) via /new-gen semantics
//            (persistGeneratedBots + default-paced connects). It NEVER removes
//            bots. The count includes names already saved in BOT_NAMES that
//            are still connecting, so a pending wave is never generated twice
//            (that runaway is what created and connected far more bots than
//            the target). Server-banned bots count as missing, so a ban wave
//            is replaced with fresh /new-gen names — exactly one per ban — and
//            the loop continues like nothing happened.
// Tor     — /lifesteal-start restarts Tor FIRST via scripts/restart-tor.sh
//            --tor-only (LIFESTEAL_TOR_RESTART_CMD override). This is the
//            ONLY thing that brings up the per-instance Tor fleet this repo
//            actually talks to (SocksPort 9050/9150/9250, ControlPort =
//            Socks+1). `brew services restart tor` is NOT it: Homebrew's
//            service has no ControlPort 9051, so a NEWNYM signal gets
//            ECONNREFUSED and no new circuit is ever requested. After the
//            restart the manager requests NEWNYM on every local control port
//            so the reconnecting bots leave on fresh paths.
//
// Deathban note: a lifesteal deathban (~24h) still lets the account join the
// server, it just cannot `/server lifesteal`. Deathbanned bots are therefore
// parked (excluded from lifesteal roles) for DEATHBAN_MS instead of removed.
//
// Wiring (see the bot.js patch in this PR):
//   const lifestealQueue = require('./lifesteal-queue').createLifestealQueue({...})
//   lifestealQueue.onDeath(id) / onKick(id, reason) / onMessage(id, text)
//   /lifesteal-start | /lifesteal-stop | /lifesteal-status
//
// The module never requires mineflayer directly so it is unit-testable with
// fake bots. All server traffic goes through deps.sendChat(id, msg).

const DEFAULTS = {
  targetBots: 20,
  // Role sizes. 0 disables the role entirely; the numbers are exact — extra
  // bots (beyond the sum of the counts) stay idle at the AFK warp.
  duelsBots: 1,
  queueBots: 1,
  arenaBots: 1,
  tpaBots: 1,
  duelsCmd: '/duelsroomqueue',
  queueCmd: '/queue',
  arenaWarp: '/warp arena',
  afkWarp: '/warp afk',
  serverCmd: '/server lifesteal',
  arenaWaitMs: 5000,
  arenaStuckMs: 2500,
  arenaStuckDist: 0.15,
  arenaTimeoutMs: 30000,
  arenaRepeatDelayMs: 2000,
  tpaIntervalMs: 5000,
  tpaCooldownMs: 1200,
  // Standalone /duelsroomspam and /queuespam re-send cadence (managed roles
  // still send once per assignment; a solo "spam" repeats).
  soloRepeatMs: 15000,
  tickMs: 3000,
  rosterTickMs: 60000,
  deathbanMs: 24 * 60 * 60 * 1000,
  resendCooldownMs: 15000,
  // Chat-based ban/deathban detection is spoofable (players can type any
  // wording), so it is only believed inside these trust windows.
  trustWindowMs: 10 * 60 * 1000, // first minutes of a session
  deathTrustMs: 2 * 60 * 1000, // right after a real death/kick event
}

function readConfig (env) {
  const e = env || {}
  const num = (key, fallback, min) => {
    const v = Number.parseInt(e[key], 10)
    if (!Number.isFinite(v)) return fallback
    return Math.max(min, v)
  }
  return {
    targetBots: num('LIFESTEAL_TARGET_BOTS', DEFAULTS.targetBots, 1),
    duelsBots: num('LIFESTEAL_DUELS_BOTS', DEFAULTS.duelsBots, 0),
    queueBots: num('LIFESTEAL_QUEUE_BOTS', DEFAULTS.queueBots, 0),
    arenaBots: num('LIFESTEAL_ARENA_BOTS', DEFAULTS.arenaBots, 0),
    tpaBots: num('LIFESTEAL_TPA_BOTS', DEFAULTS.tpaBots, 0),
    duelsCmd: (e.LIFESTEAL_DUELSROOM_CMD || DEFAULTS.duelsCmd).trim() || DEFAULTS.duelsCmd,
    queueCmd: (e.LIFESTEAL_QUEUE_CMD || DEFAULTS.queueCmd).trim() || DEFAULTS.queueCmd,
    arenaWarp: (e.LIFESTEAL_ARENA_WARP || DEFAULTS.arenaWarp).trim() || DEFAULTS.arenaWarp,
    afkWarp: (e.LIFESTEAL_AFK_WARP || e.WARP_COMMAND || DEFAULTS.afkWarp).trim() || DEFAULTS.afkWarp,
    serverCmd: (e.LIFESTEAL_SERVER_CMD || e.SERVER_COMMAND || DEFAULTS.serverCmd).trim() || DEFAULTS.serverCmd,
    arenaWaitMs: num('LIFESTEAL_ARENA_WAIT_MS', DEFAULTS.arenaWaitMs, 0),
    arenaStuckMs: num('LIFESTEAL_ARENA_STUCK_MS', DEFAULTS.arenaStuckMs, 500),
    arenaStuckDist: Number.isFinite(Number(e.LIFESTEAL_ARENA_STUCK_DIST)) ? Number(e.LIFESTEAL_ARENA_STUCK_DIST) : DEFAULTS.arenaStuckDist,
    arenaTimeoutMs: num('LIFESTEAL_ARENA_TIMEOUT_MS', DEFAULTS.arenaTimeoutMs, 5000),
    arenaRepeatDelayMs: num('LIFESTEAL_ARENA_REPEAT_MS', DEFAULTS.arenaRepeatDelayMs, 0),
    tpaIntervalMs: num('LIFESTEAL_TPA_INTERVAL_MS', DEFAULTS.tpaIntervalMs, 1000),
    tpaCooldownMs: num('LIFESTEAL_TPA_COOLDOWN_MS', DEFAULTS.tpaCooldownMs, 0),
    soloRepeatMs: num('LIFESTEAL_SOLO_REPEAT_MS', DEFAULTS.soloRepeatMs, 1000),
    tickMs: num('LIFESTEAL_TICK_MS', DEFAULTS.tickMs, 1000),
    rosterTickMs: num('LIFESTEAL_ROSTER_TICK_MS', DEFAULTS.rosterTickMs, 15000),
    deathbanMs: num('LIFESTEAL_DEATHBAN_MS', DEFAULTS.deathbanMs, 60000),
    resendCooldownMs: num('LIFESTEAL_RESEND_MS', DEFAULTS.resendCooldownMs, 5000),
    trustWindowMs: num('LIFESTEAL_TRUST_WINDOW_MS', DEFAULTS.trustWindowMs, 1000),
    deathTrustMs: num('LIFESTEAL_DEATH_TRUST_MS', DEFAULTS.deathTrustMs, 1000),
  }
}

// Tor restart command used ONLY by /lifesteal-start (runs first, before any
// role assignment). Deliberately separate from PROXY_RESTART_CMD so no other
// Tor behavior changes. Default is the repo's own Tor supervisor — the only
// thing that (re)creates the control ports this fleet signals:
//   scripts/restart-tor.sh --tor-only   (needs root on the box)
function lifestealTorRestartCmd (env) {
  const e = env || {}
  const custom = String(e.LIFESTEAL_TOR_RESTART_CMD || '').trim()
  return custom || 'sudo -n bash ./scripts/restart-tor.sh --tor-only'
}

// Deathban wording seen on lifesteal servers: "deathban", "death banned",
// "banned for 24 hours", "you are deathbanned until ...".
const DEATHBAN_RE = /death[\s-]*ban|banned for\s+24\s*hour|you (are|have been) (temporarily )?banned/i

function isDeathbanText (text) {
  if (!text) return false
  return DEATHBAN_RE.test(String(text))
}

// Player chat always carries the sender ("name: msg", "<name> msg", with
// optional rank tags). Any line shaped like that is somebody typing in chat —
// they can write "You are deathbanned…" or "Kicked: {…}" verbatim and it must
// never be believed as a server notice. System lines (real deathban/kick
// screens) have no name-shaped prefix. Mirrors the detectPlayerChat filter
// bot.js applies to its own ban/auth handlers, kept local so this module stays
// dependency-free.
function looksLikePlayerChat (text) {
  const clean = String(text || '')
    .replace(/\u00a7./g, '')
    .replace(/\s*[»›]\s*/g, ': ') // "Name » msg" style chat separators
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const stripped = clean.replace(/^(?:\[[^\]]{1,24}\]\s*)+/, '')
  return /^(?:<[A-Za-z0-9_]{1,16}>|[A-Za-z0-9_]{1,16}:)\s*\S/.test(stripped)
}

function pickRandom (arr, rand) {
  if (!arr.length) return null
  const r = typeof rand === 'function' ? rand(arr.length) : Math.floor(Math.random() * arr.length)
  return arr[Math.max(0, Math.min(arr.length - 1, r))]
}

// Blocked ahead? Probe the cell in front of the eyes/feet along the yaw.
// Returns true when a solid block is within ~0.7m (i.e. "hit something").
function isBlockedAhead (bot) {
  try {
    const entity = bot && bot.entity
    if (!entity || !entity.position) return false
    const yaw = entity.yaw || 0
    // Mineflayer yaw: 0 = -Z... forward vector:
    const dx = -Math.sin(yaw)
    const dz = -Math.cos(yaw)
    const base = entity.position
    if (typeof bot.blockAt !== 'function') return false
    const probes = [
      base.offset(dx * 0.7, 0, dz * 0.7),
      base.offset(dx * 0.7, 1, dz * 0.7),
    ]
    for (const p of probes) {
      let b = null
      try { b = bot.blockAt(p) } catch (_) { b = null }
      if (b && b.name && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') {
        // boundingBox 'empty' blocks (light/buttons) don't count as a hit.
        if (b.boundingBox === 'empty') continue
        return true
      }
    }
    return false
  } catch (_) { return false }
}

function visiblePlayers (bot, fleetNames) {
  try {
    const players = (bot && bot.players) || {}
    const fleet = new Set((fleetNames || []).map(n => String(n).toLowerCase()))
    return Object.keys(players)
      .filter(name => name && !fleet.has(String(name).toLowerCase()))
      .sort((a, b) => String(a).localeCompare(String(b)))
  } catch (_) { return [] }
}

function createLifestealQueue (deps) {
  deps = deps || {}
  const getBots = deps.getBots || (() => ({}))
  const isOnline = deps.isOnline || (() => false)
  const sendChat = deps.sendChat || (() => false)
  const log = deps.log || (() => {})
  const rand = deps.rand || null
  const now = deps.now || (() => Date.now())
  const setTimer = deps.setTimer || setTimeout
  const clearTimer = deps.clearTimer || clearTimeout
  // The steady tick / fast arena poll pulses. Tests stub these (they drive
  // tick() manually with a fake clock) so no real-time interval interferes.
  const setPulse = deps.setPulse || setInterval
  const clearPulse = deps.clearPulse || clearInterval
  // ensureRoster(missing) -> called when fleet is below target; bot.js wires
  // this to persistGeneratedBots + staggered createBotInstance. Never removes.
  const ensureRoster = deps.ensureRoster || (() => ({ ok: false, error: 'no roster hook' }))
  // isBanned(id) -> true when the account is server-banned (bot.js wires this
  // to the persisted dataStore ban flag). Banned bots are excluded from roles
  // and counted as missing so /new-gen replaces them.
  const isBanned = deps.isBanned || (() => false)
  const getEnv = deps.getEnv || (() => ({}))

  const state = {
    running: false,
    cfg: readConfig(getEnv()),
    // Role holders are ARRAYS: LIFESTEAL_*_BOTS decides how many bots run each
    // role (default 1 each, matching the old single-holder behavior).
    roles: { duels: [], queue: [], arena: [], tpa: [] },
    deathbanned: new Map(), // id -> expiryMs
    activeSince: new Map(), // id -> when first seen online (chat trust window)
    lastRealEventAt: new Map(), // id -> last real death/kick (reopens trust window)
    afkSent: new Set(), // bots already parked at /warp afk (avoid chat spam)
    lastSent: new Map(), // `${id}:${cmd}` -> timestamp (resend cooldown)
    arenaRun: new Map(), // id -> per-bot walk state (phase/waitUntil/…)
    tpaRun: new Map(), // id -> per-bot round-robin cursor (index/nextAt/…)
    solo: null, // { role, count, lastRepeat } while a standalone routine runs
    timers: [],
    lastRosterCheck: 0,
  }

  const ROLE_ORDER = ['duels', 'queue', 'arena', 'tpa']
  const SOLO_ROLES = new Set([...ROLE_ORDER, 'afk'])

  function onlineIds () {
    const bots = getBots() || {}
    return Object.keys(bots).filter(id => {
      if (isDeathbanned(id)) return false
      try { if (isBanned(id)) return false } catch (_) {}
      try { return isOnline(bots[id]) } catch (_) { return false }
    })
  }

  function bannedIds () {
    const bots = getBots() || {}
    return Object.keys(bots).filter(id => {
      try { return isBanned(id) } catch (_) { return false }
    })
  }

  function allIds () {
    return Object.keys(getBots() || {})
  }

  // Every configured account: the live roster plus the names already saved in
  // BOT_NAMES. /new-gen writes names to .env BEFORE their staggered connects
  // fire, so counting only the live map made every roster tick re-generate the
  // still-pending wave — creating and connecting far more bots than the target.
  function configuredIds () {
    const ids = new Set(allIds())
    const env = getEnv() || {}
    for (const raw of String(env.BOT_NAMES || '').split(',')) {
      const name = raw.trim()
      if (name) ids.add(name)
    }
    return [...ids]
  }

  function isDeathbanned (id) {
    const exp = state.deathbanned.get(id)
    if (!exp) return false
    if (exp <= now()) { state.deathbanned.delete(id); return false }
    return true
  }

  function markDeathbanned (id, reason) {
    state.deathbanned.set(id, now() + state.cfg.deathbanMs)
    releaseRole(id, true)
    try { stopForward(id) } catch (_) {}
    log(id, `deathbanned (${reason || 'detected'}) — parked for 24h, excluded from lifesteal roles`)
  }

  // Session bookkeeping for the chat trust window: each bot's clock starts
  // when it is first seen online and resets when it drops off (a reconnect is
  // a fresh session). Real death/kick events reopen the window — that is when
  // a genuine deathban notice actually arrives.
  function noteSessions () {
    const bots = getBots() || {}
    for (const id of Object.keys(bots)) {
      let on = false
      try { on = isOnline(bots[id]) } catch (_) { on = false }
      if (on) {
        if (!state.activeSince.has(id)) state.activeSince.set(id, now())
      } else {
        state.activeSince.delete(id)
      }
    }
  }

  function noteRealEvent (id) {
    state.lastRealEventAt.set(id, now())
  }

  // Chat-based deathban text is only believed inside a trust window: the first
  // few minutes a bot is active, or the minutes right after a real death/kick.
  // Outside those windows a matching line is treated as somebody typing server
  // wording in chat — which anyone can do — and ignored. Real kick packets
  // (onKick) never need a window; players cannot forge those.
  function messageTrusted (id) {
    const since = state.activeSince.get(id)
    if (since != null && now() - since <= state.cfg.trustWindowMs) return true
    const ev = state.lastRealEventAt.get(id) || 0
    return ev > 0 && now() - ev <= state.cfg.deathTrustMs
  }

  function roleTaken () {
    const taken = new Set()
    for (const ids of Object.values(state.roles)) for (const id of ids) taken.add(id)
    return taken
  }

  function say (id, cmd) {
    const key = `${id}:${cmd}`
    const last = state.lastSent.get(key) || 0
    if (now() - last < state.cfg.resendCooldownMs) return true
    let ok = false
    try { ok = sendChat(id, cmd) !== false } catch (_) { ok = false }
    if (ok !== false) state.lastSent.set(key, now())
    return ok
  }

  // Pick a random ONLINE bot, optionally excluding ids. The dead holder is
  // NOT excluded on purpose (replacement "could be the same bot").
  function pickOnline (exclude) {
    const ex = exclude instanceof Set ? exclude : new Set(exclude || [])
    const pool = onlineIds().filter(id => !ex.has(id))
    if (!pool.length) return null
    return pickRandom(pool, rand)
  }

  function assignRole (role, id, cmd) {
    state.roles[role].push(id)
    state.afkSent.delete(id)
    if (role === 'arena') startArenaRun(id)
    if (role === 'tpa') state.tpaRun.set(id, { index: 0, nextAt: 0, lastTarget: null })
    // Role assignment must always (re-)send the command, even if the same bot
    // is picked again within the resend cooldown (per spec: replacement
    // "could be the same bot, don't restrict it like that").
    if (cmd) {
      state.lastSent.delete(`${id}:${cmd}`)
      say(id, cmd)
    }
    log(null, `${role} → ${id} (${cmd || 'assigned'})`)
  }

  function dropHolder (role, id, silent) {
    const holders = state.roles[role]
    const at = holders.indexOf(id)
    if (at === -1) return false
    holders.splice(at, 1)
    if (role === 'arena') { try { stopForward(id) } catch (_) {} state.arenaRun.delete(id) }
    if (role === 'tpa') state.tpaRun.delete(id)
    if (!silent) log(null, `${role} released from ${id}`)
    return true
  }

  function releaseRole (id, silent) {
    for (const role of ROLE_ORDER) dropHolder(role, id, silent)
  }

  function roleOf (id) {
    for (const role of ROLE_ORDER) {
      if (state.roles[role].includes(id)) return role
    }
    return null
  }

  function stopForward (id) {
    const bots = getBots() || {}
    const bot = bots[id] && bots[id].bot
    if (!bot) return
    try { bot.clearControlStates() } catch (_) {}
    try { bot.setControlState('forward', false) } catch (_) {}
  }

  function startForward (id) {
    const bots = getBots() || {}
    const bot = bots[id] && bots[id].bot
    if (!bot) return false
    try {
      bot.clearControlStates()
      bot.setControlState('forward', true)
      bot.setControlState('sprint', false)
      bot.setControlState('jump', false)
      bot.setControlState('sneak', false)
      return true
    } catch (_) { return false }
  }

  function botPos (id) {
    try {
      const bots = getBots() || {}
      const bot = bots[id] && bots[id].bot
      const p = bot && bot.entity && bot.entity.position
      return p ? { x: p.x, y: p.y, z: p.z } : null
    } catch (_) { return null }
  }

  function dist3 (a, b) {
    if (!a || !b) return Infinity
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  }

  // ── per-role maintenance (called on tick) ──────────────────────────────
  // How many bots a role wants: the configured count in managed mode, and the
  // standalone [count] (0 = every online bot) for a solo routine. Any role the
  // solo run did not ask for wants nothing.
  function wantedCount (role) {
    if (state.solo) return role === state.solo.role ? (state.solo.count || Infinity) : 0
    if (role === 'duels') return state.cfg.duelsBots
    if (role === 'queue') return state.cfg.queueBots
    if (role === 'arena') return state.cfg.arenaBots
    return state.cfg.tpaBots
  }

  function maintainRoles () {
    const onlineSet = new Set(onlineIds())
    // 1. Drop holders that are gone (offline, deathbanned or banned — the
    //    onlineIds filter covers all three). A refill below may pick the very
    //    same bot again once it is usable: replacements are never restricted.
    for (const role of ROLE_ORDER) {
      for (const id of [...state.roles[role]]) {
        if (!onlineSet.has(id)) dropHolder(role, id, true)
      }
    }
    // 2. Shrink when a count was lowered live — the extras go back to idle.
    for (const role of ROLE_ORDER) {
      const want = wantedCount(role)
      while (state.roles[role].length > want) {
        const id = state.roles[role][state.roles[role].length - 1]
        dropHolder(role, id)
        parkAfk(id)
      }
    }
    // 3. Fill every short role from the online pool. A bot holds at most one
    //    role, so each round of filling excludes everyone already holding.
    for (const role of ROLE_ORDER) {
      const want = wantedCount(role)
      const cmd = role === 'duels' ? state.cfg.duelsCmd : role === 'queue' ? state.cfg.queueCmd : null
      while (state.roles[role].length < want) {
        const next = pickOnline(roleTaken())
        if (!next) break
        assignRole(role, next, cmd)
      }
    }
  }

  function startArenaRun (id) {
    state.afkSent.delete(id)
    state.arenaRun.set(id, { phase: 'wait', waitUntil: 0, forwardSince: 0, lastPos: null, stuckSince: 0, timeoutAt: 0 })
    // Phase 1: warp, then wait 5s before walking.
    state.lastSent.delete(`${id}:${state.cfg.arenaWarp}`)
    say(id, state.cfg.arenaWarp)
    const run = state.arenaRun.get(id)
    run.phase = 'wait'
    run.waitUntil = now() + state.cfg.arenaWaitMs
    log(null, `arena → ${id} (${state.cfg.arenaWarp}, walking in 5s)`)
  }

  function parkAfk (id) {
    if (!id) return
    const bots = getBots() || {}
    if (!bots[id]) return
    // Deathbanned bots can still join the server but must not be sent to
    // lifesteal — parking them at afk is safe only when already there.
    // We still send one /warp afk so they sit out of the way.
    if (state.afkSent.has(id)) return
    try { if (!isOnline(bots[id])) return } catch (_) { return }
    if (roleOf(id)) return // still holding a role — don't yank it to afk
    if (say(id, state.cfg.afkWarp)) state.afkSent.add(id)
  }

  function maintainIdle () {
    const taken = roleTaken()
    // Standalone /afk-park parks at most [count] bots (0 = everyone).
    let budget = state.solo && state.solo.role === 'afk' ? (state.solo.count || Infinity) : Infinity
    for (const id of onlineIds()) {
      if (budget <= 0) break
      if (taken.has(id)) continue
      budget--
      parkAfk(id)
    }
  }

  function maintainArena () {
    // Each arena holder walks its own loop; runs map keeps per-bot phase.
    for (const id of [...state.arenaRun.keys()]) {
      if (!state.roles.arena.includes(id)) { state.arenaRun.delete(id); continue }
      const bots = getBots() || {}
      const entry = bots[id]
      if (!entry || !isOnline(entry)) continue // replacement handled by maintainRoles
      const bot = entry.bot
      if (!bot || !bot.entity) continue
      const t = now()
      const a = state.arenaRun.get(id)
      if (a.phase === 'wait') {
        if (t >= a.waitUntil) {
          if (startForward(id)) {
            a.phase = 'forward'
            a.forwardSince = t
            a.lastPos = botPos(id)
            a.stuckSince = t
            a.timeoutAt = t + state.cfg.arenaTimeoutMs
            log(id, 'arena: holding forward until collision')
          } else {
            a.waitUntil = t + 2000 // retry shortly
          }
        }
        continue
      }
      if (a.phase === 'forward') {
        const pos = botPos(id)
        // Hit something? Solid block directly ahead counts immediately.
        let blocked = false
        try { blocked = isBlockedAhead(bot) } catch (_) { blocked = false }
        if (blocked) {
          stopForward(id)
          log(id, 'arena: hit something — stopping, re-warping')
          a.phase = 'cooldown'
          a.waitUntil = t + state.cfg.arenaRepeatDelayMs
          continue
        }
        // Stuck in place while holding forward counts as "hit something".
        if (pos && a.lastPos) {
          if (dist3(pos, a.lastPos) >= state.cfg.arenaStuckDist) {
            a.lastPos = pos
            a.stuckSince = t
          } else if (t - a.stuckSince >= state.cfg.arenaStuckMs) {
            stopForward(id)
            log(id, 'arena: stuck (no movement) — stopping, re-warping')
            a.phase = 'cooldown'
            a.waitUntil = t + state.cfg.arenaRepeatDelayMs
            continue
          }
        } else if (pos) {
          a.lastPos = pos
        }
        if (t >= a.timeoutAt) {
          stopForward(id)
          log(id, 'arena: walk timeout — re-warping')
          a.phase = 'cooldown'
          a.waitUntil = t + state.cfg.arenaRepeatDelayMs
        }
        continue
      }
      if (a.phase === 'cooldown') {
        if (t >= a.waitUntil) {
          state.lastSent.delete(`${id}:${state.cfg.arenaWarp}`)
          say(id, state.cfg.arenaWarp)
          a.phase = 'wait'
          a.waitUntil = t + state.cfg.arenaWaitMs
        }
        continue
      }
      if (a.phase === 'idle') {
        state.lastSent.delete(`${id}:${state.cfg.arenaWarp}`)
        say(id, state.cfg.arenaWarp)
        a.phase = 'wait'
        a.waitUntil = t + state.cfg.arenaWaitMs
      }
    }
  }

  function maintainTpa () {
    const t = now()
    for (const id of [...state.roles.tpa]) {
      const run = state.tpaRun.get(id) || { index: 0, nextAt: 0, lastTarget: null }
      state.tpaRun.set(id, run)
      if (t < run.nextAt) continue
      const bots = getBots() || {}
      const entry = bots[id]
      if (!entry || !isOnline(entry)) continue
      const bot = entry.bot
      if (!bot) continue
      const names = visiblePlayers(bot, allIds())
      if (!names.length) {
        run.nextAt = t + state.cfg.tpaIntervalMs
        continue
      }
      const target = names[run.index % names.length]
      run.index += 1
      run.lastTarget = target
      say(id, `/tpa ${target}`)
      run.nextAt = t + state.cfg.tpaCooldownMs + Math.floor(Math.random() * Math.max(0, state.cfg.tpaIntervalMs - state.cfg.tpaCooldownMs))
    }
  }

  function requestTopUp (missing, why) {
    if (!(missing > 0)) return
    log(null, `roster ${why} — requesting ${missing} via /new-gen (never removes)`)
    try {
      const out = ensureRoster(missing)
      if (out && typeof out.then === 'function') out.catch(err => log(null, `roster top-up failed: ${err && err.message ? err.message : err}`))
    } catch (err) { log(null, `roster top-up failed: ${err && err.message ? err.message : err}`) }
  }

  function maintainRoster () {
    const t = now()
    if (t - state.lastRosterCheck < state.cfg.rosterTickMs) return
    state.lastRosterCheck = t
    state.cfg = readConfig(getEnv())
    // Count CONFIGURED accounts (live bots plus names already saved in
    // BOT_NAMES), not just connected ones — a generated name is saved before
    // its connect fires, and counting only the live map re-generated the whole
    // pending wave on every tick ("creates and connect bots TOO MUCH").
    // Banned bots still count as missing so a ban is replaced, but the fresh
    // name lands in BOT_NAMES immediately, so onBan's order plus this check
    // can never produce two replacements for one ban.
    const roster = configuredIds()
    let banned = 0
    for (const id of roster) {
      try { if (isBanned(id)) banned++ } catch (_) {}
    }
    const effective = roster.length - banned
    const missing = state.cfg.targetBots - effective
    if (missing > 0) {
      requestTopUp(missing, `${effective}/${state.cfg.targetBots} usable (${banned} banned)`)
    }
  }

  function tick () {
    if (!state.running) return
    state.cfg = readConfig(getEnv())
    noteSessions()
    maintainRoles()
    if (state.solo && (state.solo.role === 'duels' || state.solo.role === 'queue')) maintainSoloRepeat()
    maintainArena()
    maintainTpa()
    maintainIdle()
    // A standalone routine runs the routine only — no roster top-up (that
    // would call /new-gen and create accounts the user never asked for).
    if (!state.solo) maintainRoster()
  }

  // Standalone /duelsroomspam and /queuespam re-send their command on a
  // cadence (managed roles still send once per assignment — there the
  // replacement events do the re-sending).
  function maintainSoloRepeat () {
    const t = now()
    if (t - state.solo.lastRepeat < state.cfg.soloRepeatMs) return
    state.solo.lastRepeat = t
    const cmd = state.solo.role === 'duels' ? state.cfg.duelsCmd : state.cfg.queueCmd
    for (const id of state.roles[state.solo.role]) {
      state.lastSent.delete(`${id}:${cmd}`)
      say(id, cmd)
    }
  }

  function armLoops () {
    const loop = () => {
      if (!state.running) return
      try { tick() } catch (_) {}
    }
    // Steady loop; keep handles for stop().
    const iv = setPulse(loop, state.cfg.tickMs)
    if (iv && typeof iv.unref === 'function') { try { iv.unref() } catch (_) {} }
    state.timers.push(iv)
    // Fast arena poll (collision/stuck needs <1s granularity).
    const arenaIv = setPulse(() => { if (state.running) { try { maintainArena() } catch (_) {} } }, 250)
    if (arenaIv && typeof arenaIv.unref === 'function') { try { arenaIv.unref() } catch (_) {} }
    state.timers.push(arenaIv)
  }

  function start () {
    state.cfg = readConfig(getEnv())
    if (state.solo) return { ok: false, error: 'a standalone routine is running — stop it first' }
    if (state.running) return { ok: false, error: 'already running' }
    state.running = true
    state.lastRosterCheck = 0
    state.afkSent.clear()
    armLoops()
    tick()
    log(null, `lifesteal automation started (target ${state.cfg.targetBots} bots; duels=${state.cfg.duelsBots}×${state.cfg.duelsCmd} queue=${state.cfg.queueBots}×${state.cfg.queueCmd} arena=${state.cfg.arenaBots}×${state.cfg.arenaWarp} tpa=${state.cfg.tpaBots})`)
    return { ok: true }
  }

  // Standalone routines: run ONE role on the bots already online — no roster
  // top-up, no /new-gen, no Tor restart. count 0 = every online bot.
  function startSolo (role, count) {
    if (!SOLO_ROLES.has(role)) return { ok: false, error: `unknown routine: ${role}` }
    if (state.running) return { ok: false, error: state.solo ? 'a standalone routine is already running — stop it first' : 'stop /lifesteal-start first' }
    const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
    state.cfg = readConfig(getEnv())
    state.solo = { role, count: n, lastRepeat: now() }
    state.running = true
    state.afkSent.clear()
    armLoops()
    tick()
    log(null, `standalone ${role} routine started (${n > 0 ? `${n} bot(s)` : 'all online bots'}${role === 'duels' || role === 'queue' ? `, re-sending every ${state.cfg.soloRepeatMs}ms` : ''})`)
    return { ok: true, role, count: n }
  }

  function stopSolo () {
    if (!state.solo) return { ok: false, error: 'no standalone routine running' }
    return stop()
  }

  function stop () {
    if (!state.running) return { ok: false, error: 'not running' }
    state.running = false
    for (const t of state.timers) { try { clearPulse(t) } catch (_) {} }
    state.timers.length = 0
    // Release held forward keys and every role slot.
    for (const ids of Object.values(state.roles)) {
      for (const id of ids) { try { stopForward(id) } catch (_) {} }
    }
    for (const role of ROLE_ORDER) state.roles[role].length = 0
    state.arenaRun.clear()
    state.tpaRun.clear()
    state.solo = null
    log(null, 'lifesteal automation stopped')
    return { ok: true }
  }

  function status () {
    return {
      running: state.running,
      solo: state.solo ? { role: state.solo.role, count: state.solo.count } : null,
      cfg: { ...state.cfg },
      roles: {
        duels: [...state.roles.duels],
        queue: [...state.roles.queue],
        arena: [...state.roles.arena],
        tpa: [...state.roles.tpa],
      },
      online: onlineIds().length,
      total: allIds().length,
      deathbanned: [...state.deathbanned.entries()].map(([bot, exp]) => ({ bot, expiresInMs: Math.max(0, exp - now()) })),
      arena: [...state.arenaRun.entries()].map(([bot, run]) => ({ bot, phase: run.phase })),
      tpa: [...state.tpaRun.entries()].map(([bot, run]) => ({ bot, lastTarget: run.lastTarget })),
    }
  }

  // ── events ─────────────────────────────────────────────────────────────
  // A server ban must not stall the loop: drop the role, immediately order a
  // /new-gen replacement for the lost bot, and refill the role from whoever
  // is still usable. The banned account itself is left alone (never removed).
  function onBan (id, reason) {
    if (!state.running) return
    const r = roleOf(id)
    try { stopForward(id) } catch (_) {}
    const nextStep = state.solo ? 'dropping the role' : 'replacing via /new-gen and picking a new random bot'
    if (r) {
      dropHolder(r, id, true)
      log(null, `${r} bot ${id} banned (${reason || 'ban detected'}) — ${nextStep}`)
    } else {
      log(null, `bot ${id} banned (${reason || 'ban detected'}) — ${state.solo ? 'no role held' : 'replacing via /new-gen'}`)
    }
    state.afkSent.delete(id)
    // Standalone routines never create accounts — only the managed loop
    // orders a /new-gen replacement for a banned bot.
    if (!state.solo) requestTopUp(1, `ban replacement for ${id}`)
    try { tick() } catch (_) {}
  }

  function onDeath (id) {
    if (!state.running) return
    noteRealEvent(id)
    if (isDeathbanned(id)) return
    const r = roleOf(id)
    try { stopForward(id) } catch (_) {}
    if (r) {
      // Clear immediately; next tick picks a fresh random bot (possibly same).
      dropHolder(r, id, true)
      state.afkSent.delete(id)
      log(null, `${r} bot ${id} died — picking a new random bot`)
      try { tick() } catch (_) {}
    }
  }

  function onKick (id, reason) {
    if (!state.running) return
    noteRealEvent(id)
    // A kick is a real server packet — nobody can type one into chat — so its
    // wording is always believed, with no trust window.
    const text = String(reason || '')
    if (isDeathbanText(text)) { markDeathbanned(id, 'kick: ' + text.slice(0, 120)); try { tick() } catch (_) {}; return }
    // Any other kick/disconnect of a role holder triggers replacement.
    const r = roleOf(id)
    if (r) {
      try { stopForward(id) } catch (_) {}
      dropHolder(r, id, true)
      log(null, `${r} bot ${id} disconnected — picking a new random bot`)
      try { tick() } catch (_) {}
    }
  }

  function onMessage (id, text) {
    if (!state.running) return
    // Typed chat can imitate any server wording — "You are deathbanned…",
    // "Kicked: {\"color\":…}" — so two independent gates apply before a
    // message is believed: (1) a line shaped like player chat (name-prefixed,
    // optional rank tag) is never trusted, and (2) plain-looking lines are only
    // trusted inside the message trust window (first minutes of the session, or
    // right after a real death/kick). See looksLikePlayerChat/messageTrusted.
    if (looksLikePlayerChat(text)) return
    if (!messageTrusted(id)) return
    if (isDeathbanText(text)) {
      // A trusted deathban notice means the account is out for 24h even if it
      // already lost its role to the death event — park it so it is not
      // re-picked while deathbanned.
      markDeathbanned(id, 'deathban message')
      try { tick() } catch (_) {}
    }
  }

  return {
    start, stop, status, tick,
    startSolo, stopSolo,
    onDeath, onKick, onBan, onMessage,
    isDeathbanned, roleOf, bannedIds,
    _state: state, _readConfig: readConfig,
  }
}

module.exports = {
  createLifestealQueue,
  looksLikePlayerChat,
  lifestealTorRestartCmd,
  readConfig,
  isDeathbanText,
  isBlockedAhead,
  visiblePlayers,
  DEFAULTS,
}
