'use strict'
// ── KOS: kill-on-sight combat with fleet-staggered hits ─────────────────────
// /kos is /freeforall with a trust filter and paced hits:
//
//   * Targets are PLAYERS in reach who are NOT protected — never the TPA main
//     player (TPA_MAIN_PLAYER), never the fleet's own bots, never
//     TPA_TRUSTED_BOTS names (the same "tpa main player and bots list"
//     /tpauto trusts). So when a random player accepts a /tpa or /tpahere and
//     lands in the middle of the fleet, every armed bot engages them — and
//     nobody else. A protection lookup that throws counts as protected: when
//     unsure, never swing.
//
//   * Hits are SPREAD OUT on purpose. Vanilla (1.21.x) damage immunity: once
//     a target is hurt it rejects further hits for 10 ticks (0.5s) — a hit
//     landing inside that window adds at most the difference over the previous
//     hit, usually zero. If every bot swings at once on a freshly tpaccept'd
//     player, nearly every hit is wasted ("max damage per window" — only the
//     strongest hit in the window really counts). So the fleet attacks in a
//     rotation instead:
//       - KOS_ENGAGE_DELAY_MS (500) after the target FIRST comes in reach
//         (the /tpaccept moment) before the first hit;
//       - at most ONE fleet hit per target per KOS_STAGGER_MS (550 = 11
//         ticks — one tick of margin over the 10-tick immunity window),
//         least-recent attacker first so every armed bot gets a swing;
//       - each bot also waits KOS_BOT_COOLDOWN_MS (600 — netherite sword
//         recharge) plus KOS_BOT_COOLDOWN_JITTER_MS (0-100 = give or take a
//         couple of ticks) between its OWN hits so every hit is full strength.
//
//   * Nothing lands on a fixed rhythm. Every hit draws fresh random jitter at
//     the moment it lands (KOS_BOT_COOLDOWN_JITTER_MS for the bot's own
//     recharge, KOS_STAGGER_JITTER_MS for the fleet hit slot), so consecutive
//     swings are never evenly spaced — a metronome cadence is exactly the
//     kind of pattern that gets flagged. Jitter is strictly ADDITIVE: a hit
//     can land late, never early, so the immunity window and the full weapon
//     recharge are still respected.
//
// Combat rules match /freeforall: best weapon in hand, never a shield, no
// moving, no block breaking.
//
// The module never requires mineflayer, so it is unit-testable with fake bots.
// Bots, the clock, timers and settings all arrive through deps (bot.js wires
// the real ones).

const DEFAULTS = {
  engageDelayMs: 500,
  staggerMs: 550,
  staggerJitterMs: 50,
  botCooldownMs: 600,
  botCooldownJitterMs: 100,
  tickMs: 50,
}

// Vanilla survival attack reach — deliberately NOT extended: no reach
// advantage. pickTarget does no line-of-sight check, so hits still land
// through walls (kept on purpose).
const REACH = 3.0

// A target out of every armed bot's reach this long is forgotten; if it comes
// back (e.g. another /tpaccept) the engage delay starts fresh.
const TARGET_PRUNE_MS = 30000

function readConfig (env) {
  const e = env || {}
  const num = (key, fallback, min) => {
    const v = Number.parseInt(e[key], 10)
    if (!Number.isFinite(v)) return fallback
    return Math.max(min, v)
  }
  return {
    engageDelayMs: num('KOS_ENGAGE_DELAY_MS', DEFAULTS.engageDelayMs, 0),
    staggerMs: num('KOS_STAGGER_MS', DEFAULTS.staggerMs, 0),
    staggerJitterMs: num('KOS_STAGGER_JITTER_MS', DEFAULTS.staggerJitterMs, 0),
    botCooldownMs: num('KOS_BOT_COOLDOWN_MS', DEFAULTS.botCooldownMs, 0),
    botCooldownJitterMs: num('KOS_BOT_COOLDOWN_JITTER_MS', DEFAULTS.botCooldownJitterMs, 0),
    tickMs: num('KOS_TICK_MS', DEFAULTS.tickMs, 50),
  }
}

function targetKey (ent) {
  return String((ent && (ent.username || ent.name)) || '').toLowerCase()
}

// Nearest unprotected PLAYER within reach, or null. Mobs are never KOS
// targets — /kos only attacks "people".
function pickTarget (bot, selfId, isProtectedName, reach) {
  try {
    const selfPos = bot && bot.entity && bot.entity.position
    if (!selfPos) return null
    const selfLower = String(selfId || '').toLowerCase()
    let best = null
    let bestDist = Infinity
    const consider = (ent) => {
      if (!ent || ent === bot.entity || !ent.position) return
      const name = String(ent.username || ent.name || '')
      const lower = name.toLowerCase()
      if (!lower || lower === selfLower) return
      let protectedName = true
      try { protectedName = isProtectedName(name) !== false } catch (_) { protectedName = true }
      if (protectedName) return
      const dist = Math.hypot(ent.position.x - selfPos.x, ent.position.y - selfPos.y, ent.position.z - selfPos.z)
      if (dist > reach) return
      if (dist < bestDist) { bestDist = dist; best = ent }
    }
    if (bot.players && typeof bot.players === 'object') {
      for (const p of Object.values(bot.players)) if (p && p.entity) consider(p.entity)
    }
    if (bot.entities && typeof bot.entities === 'object') {
      for (const ent of Object.values(bot.entities)) {
        if (!ent || ent === bot.entity) continue
        const type = String(ent.type || '').toLowerCase()
        if (type === 'player' || ent.username) consider(ent)
      }
    }
    return best
  } catch (_) { return null }
}

function createKos (deps) {
  deps = deps || {}
  const getBots = deps.getBots || (() => ({}))
  const isProtectedName = deps.isProtectedName || (() => true)
  const pickBestWeapon = deps.pickBestWeapon || (() => null)
  const log = deps.log || (() => {})
  const now = deps.now || (() => Date.now())
  const setPulse = deps.setPulse || setInterval
  const clearPulse = deps.clearPulse || clearInterval
  const getEnv = deps.getEnv || (() => ({}))
  const rand = deps.rand || Math.random

  // Random 0..max ms of extra delay — strictly additive, so a hit can land
  // late but never before its minimum spacing.
  function jitterMs (max) {
    const cap = Math.floor(Number(max) || 0)
    if (cap <= 0) return 0
    return Math.min(cap, Math.floor(rand() * (cap + 1)))
  }

  const state = {
    running: new Set(), // ids with the KOS loop armed
    runs: new Map(), // id -> { lastAttackAt, busy }
    targets: new Map(), // target key -> { firstSeenAt, lastHitAt, lastSeenAt }
    timer: null,
  }

  function armLoop () {
    if (state.timer) return
    const cfg = readConfig(getEnv())
    const iv = setPulse(() => {
      if (!state.running.size) return
      try { tick() } catch (_) {}
    }, cfg.tickMs)
    if (iv && typeof iv.unref === 'function') { try { iv.unref() } catch (_) {} }
    state.timer = iv || null
  }

  function disarmLoop () {
    if (state.timer) { try { clearPulse(state.timer) } catch (_) {} state.timer = null }
  }

  async function tickOne (id) {
    const entry = getBots()[id]
    if (!entry || !entry.bot || !entry.bot.entity) return
    let run = state.runs.get(id)
    if (!run) { run = { lastAttackAt: 0, busy: false }; state.runs.set(id, run) }
    if (run.busy) return
    run.busy = true
    try {
      const bot = entry.bot
      const cfg = readConfig(getEnv())
      // Strictly no moving and no block breaking (same as /freeforall).
      try { if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop() } catch (_) {}
      try { if (typeof bot.clearControlStates === 'function') bot.clearControlStates() } catch (_) {}
      try { if (bot.targetDigBlock && typeof bot.stopDigging === 'function') bot.stopDigging() } catch (_) {}
      // Never shield.
      try { if (typeof bot.deactivateItem === 'function') bot.deactivateItem() } catch (_) {}
      try {
        const offhand = bot.inventory && bot.inventory.slots && bot.inventory.slots[45]
        if (offhand && String(offhand.name || '').toLowerCase().includes('shield') && typeof bot.unequip === 'function') {
          await bot.unequip('off-hand')
        }
      } catch (_) {}
      // Best weapon in hand (never a shield).
      try {
        const best = pickBestWeapon(bot)
        const held = bot.heldItem
        if (best && (!held || held.type !== best.type || held.slot !== best.slot)) {
          if (typeof bot.equip === 'function') await bot.equip(best, 'hand')
        } else if (held && String(held.name || '').toLowerCase().includes('shield')) {
          if (typeof bot.unequip === 'function') await bot.unequip('hand')
        }
      } catch (_) {}
      const target = pickTarget(bot, id, isProtectedName, REACH)
      if (!target || !target.position) return
      // Always keep the aim on the target, even when the swing is paced out.
      try {
        const aimHeight = Number.isFinite(target.height) ? target.height * 0.85 : 1.4
        const aimPos = typeof target.position.offset === 'function'
          ? target.position.offset(0, aimHeight, 0)
          : { x: target.position.x, y: target.position.y + aimHeight, z: target.position.z }
        if (typeof bot.lookAt === 'function') await bot.lookAt(aimPos, true)
      } catch (_) {}
      // ── the swing gate ──────────────────────────────────────────────────
      // Everything from here to bot.attack() is synchronous, so on the single
      // JS thread the check-and-hit is atomic: two bots can never both pass
      // the stagger check for the same target in the same instant.
      const key = targetKey(target)
      if (!key) return
      const t = now()
      let ts = state.targets.get(key)
      if (!ts) { ts = { firstSeenAt: t, lastHitAt: 0, lastSeenAt: t }; state.targets.set(key, ts) }
      ts.lastSeenAt = t
      // 1. The /tpaccept grace: hold the swarm until the target has been in
      //    reach for the engage delay, so it is not evaporated mid-teleport.
      if (t - ts.firstSeenAt < cfg.engageDelayMs) return
      // 2. The immunity window: the whole fleet shares one hit slot per
      //    target — hits inside 10 ticks of the previous one are wasted.
      //    The slot width is redrawn on every hit (stagger + jitter) so the
      //    fleet's swings never fall on a fixed rhythm.
      if (t < (ts.nextHitAt || 0)) return
      // 3. Each bot's own weapon recharge, so every hit is full strength —
      //    600ms minimum plus give-or-take a couple of ticks of jitter.
      if (t < (run.nextAttackAt || 0)) return
      ts.lastHitAt = t
      run.lastAttackAt = t
      ts.nextHitAt = t + cfg.staggerMs + jitterMs(cfg.staggerJitterMs)
      run.nextAttackAt = t + cfg.botCooldownMs + jitterMs(cfg.botCooldownJitterMs)
      try { bot.attack(target) } catch (_) {}
    } finally {
      run.busy = false
    }
  }

  function tick () {
    // Least-recent attacker first: when several bots are ready for the same
    // target's hit slot, the one that has waited longest wins it, so the
    // fleet's swings rotate instead of one bot hogging every slot.
    const order = [...state.running].sort((a, b) => {
      const ra = state.runs.get(a)
      const rb = state.runs.get(b)
      return ((ra && ra.lastAttackAt) || 0) - ((rb && rb.lastAttackAt) || 0)
    })
    for (const id of order) {
      tickOne(id).catch(() => {})
    }
    // Forget targets no armed bot has had in reach for a while — a returning
    // player (fresh /tpaccept) then gets the engage delay again.
    const t = now()
    for (const [key, ts] of state.targets) {
      if (t - ts.lastSeenAt > TARGET_PRUNE_MS) state.targets.delete(key)
    }
  }

  function start (id) {
    const entry = getBots()[id]
    if (!entry || !entry.bot || !entry.bot.entity) {
      log(id, `${id} is not currently spawned.`)
      return false
    }
    state.runs.set(id, { lastAttackAt: 0, busy: false })
    state.running.add(id)
    armLoop()
    const cfg = readConfig(getEnv())
    log(id, `KOS started: hitting only unprotected players (never the TPA main player, bots, or trusted names), best weapon, never shields, no moving, vanilla ${REACH}-block reach through walls — fleet hits spread ${cfg.staggerMs}-${cfg.staggerMs + cfg.staggerJitterMs}ms apart, own hits every ${cfg.botCooldownMs}-${cfg.botCooldownMs + cfg.botCooldownJitterMs}ms, first hit ${cfg.engageDelayMs}ms after a target comes in reach. Run /kos stop to end.`)
    tickOne(id).catch(() => {})
    return true
  }

  function stop (id, quiet) {
    const wasRunning = state.running.has(id)
    state.running.delete(id)
    state.runs.delete(id)
    if (!state.running.size) disarmLoop()
    if (wasRunning && !quiet) log(id, 'KOS stopped.')
    return wasRunning
  }

  function stopAll () {
    for (const id of [...state.running]) stop(id, true)
  }

  function isRunning (id) {
    return state.running.has(id)
  }

  function status () {
    const cfg = readConfig(getEnv())
    return {
      running: [...state.running],
      cfg,
      targets: [...state.targets.entries()].map(([key, ts]) => ({
        target: key,
        firstSeenAt: ts.firstSeenAt,
        lastHitAt: ts.lastHitAt,
      })),
    }
  }

  return {
    start, stop, stopAll, tick, status, isRunning,
    _state: state, _readConfig: readConfig,
  }
}

module.exports = {
  createKos,
  readConfig,
  pickTarget,
  DEFAULTS,
}
