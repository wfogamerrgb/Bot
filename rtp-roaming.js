'use strict'
const fs = require('fs')
const path = require('path')
const { readDelayMs, readInt, readNumber } = require('./bot-controls')
const INDICATORS = ['ender_chest', 'anvil', 'chipped_anvil', 'damaged_anvil', 'smithing_table', 'furnace', 'blast_furnace', 'smoker', 'enchanting_table']
const STORAGE = ['chest', 'trapped_chest', 'barrel', ...INDICATORS]
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const storageNames = [...STORAGE, 'shulker_box', ...COLORS.map(c => `${c}_shulker_box`)]
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

function createRtpRoaming({ bots, env = () => process.env, directory = __dirname, io = fs, online, busy = () => false, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, yieldTurn = () => new Promise(resolve => setImmediate(resolve)), now = Date.now, random = Math.random }) {
  const sessions = new Map()
  const history = new Map()
  let scanOwner = null // bounded fleet-wide scan work, not one expensive scan per bot
  const ms = (key, fallback) => readDelayMs(env()[key], fallback)
  const number = (key, fallback, min, max) => readNumber(env()[key], fallback, min, max)
  const alive = s => sessions.get(s.id) === s && bots[s.id]?.bot === s.bot && online(bots[s.id])
  const usable = s => alive(s) && !busy(bots[s.id]) && !s.bot.currentWindow
  function later(s, fn, delay) {
    const t = setTimer(() => { s.timers.delete(t); if (alive(s)) return fn() }, delay)
    s.timers.add(t)
    return t
  }
  function periodic(s, fn, key, fallback) {
    const run = async () => {
      try { if (usable(s)) await fn(s) } catch (err) { log(s.id, `[roam] ${String(err.message).slice(0, 200)}`) }
      if (alive(s)) later(s, run, ms(key, fallback))
    }
    later(s, run, ms(key, fallback))
  }
  function arrival(s) {
    const pending = s.arrival
    if (!pending || !alive(s) || !s.bot.entity?.position) return
    const position = s.bot.entity.position
    // A rejected RTP must not log the old position. Accept a server teleport
    // event or substantial displacement after this particular request.
    if (!pending.teleported && distance(position, pending.from) < number('RTP_MIN_MOVE_BLOCKS', 16, 1, 1000)) return
    const { x, y, z } = position
    if (![x, y, z].every(Number.isFinite)) return
    const dimension = s.bot.game?.dimension || 'unknown'
    const line = `${new Date(now()).toISOString()}\t${s.id}\t${dimension}\t${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}\n`
    try { io.appendFileSync(path.join(directory, 'rtp-locations.txt'), line) } catch (err) {
      log(s.id, `[roam] Cannot append rtp-locations.txt (${err.code || 'I/O error'}); stopping to avoid losing arrivals.`)
      stop(s.id)
      return
    }
    s.arrival = null
    log(s.id, `RTP arrival: ${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)} (${dimension})`)
    const key = `${dimension}:${Math.floor(x / 16)},${Math.floor(z / 16)}`
    const seen = (history.get(key) || 0) + 1
    history.set(key, seen)
    if (history.size > 5000) history.delete(history.keys().next().value)
    if (seen > 1) log(s.id, `RTP chunk visited ${seen} times.`)
  }
  function request(s) {
    s.rtpTimer = null
    if (!alive(s)) return
    if (!usable(s) || s.scanning || s.inventoryBusy) { s.rtpTimer = later(s, () => request(s), 2000); return }
    if (now() < s.pauseUntil) { s.rtpTimer = later(s, () => request(s), s.pauseUntil - now()); return }
    s.arrival = { from: { ...s.bot.entity.position }, teleported: false }
    try { s.bot.chat(env().RTP_COMMAND || '/rtp world world') } catch (err) {
      s.arrival = null
      log(s.id, `[roam] RTP send failed: ${err.message}`)
    }
    // Includes the initial request; movement can arrive after the old 5s timer.
    const until = now() + ms('RTP_ARRIVAL_TIMEOUT_MS', 30000)
    const check = () => {
      arrival(s)
      if (s.arrival && now() < until) later(s, check, 1000)
      else if (s.arrival) { s.arrival = null; log(s.id, 'RTP arrival not confirmed; no coordinates recorded.') }
    }
    later(s, check, 1500)
    s.rtpTimer = later(s, () => request(s), ms('RTP_INTERVAL_MS', 34800) + Math.floor(random() * 15000))
  }
  function pause(s) {
    s.pauseUntil = now() + ms('RTP_PAUSE_ON_BASE_MS', 600000)
    if (s.rtpTimer) { clearTimer(s.rtpTimer); s.timers.delete(s.rtpTimer) }
    s.rtpTimer = later(s, () => request(s), s.pauseUntil - now())
    log(s.id, `Base found; RTP paused for ${Math.round((s.pauseUntil - now()) / 60000)} minutes.`)
  }
  async function scan(s) {
    if (scanOwner || s.arrival || !s.bot.registry || !s.bot.findBlocks || !s.bot.world?.getColumn) return
    scanOwner = s
    s.scanning = true
    try {
      const bot = s.bot
      const ids = storageNames.map(name => bot.registry.blocksByName?.[name]?.id).filter(id => id !== undefined)
      if (!ids.length) return
      const origin = bot.entity.position.floored()
      const radius = number('BASE_SCAN_RADIUS', 192, 16, 512)
      const minY = bot.game?.minY ?? -64
      const maxY = minY + (bot.game?.height ?? 384) - 1
      const found = new Map()
      for (let x = origin.x - radius; x <= origin.x + radius; x += 48) {
        for (let z = origin.z - radius; z <= origin.z + radius; z += 48) {
          let loaded = false
          for (let dx = 0; dx <= 3; dx++) for (let dz = 0; dz <= 3; dz++) if (bot.world.getColumn(Math.floor(x / 16) + dx, Math.floor(z / 16) + dz)) loaded = true
          if (!loaded) continue
          for (let y = minY; y <= maxY; y += 48) {
            if (!usable(s)) return
            const center = origin.offset(x + 24 - origin.x, y + 24 - origin.y, z + 24 - origin.z)
            if (distance(center, origin) > radius + 42) continue
            // Radius 42 covers a 48^3 cube's corners; the standalone radius34
            // left gaps. Scan only loaded terrain and yield after each sphere.
            for (const p of bot.findBlocks({ matching: ids, maxDistance: 42, point: center, count: 4096 })) {
              if (distance(p, origin) <= radius) found.set(`${p.x},${p.y},${p.z}`, p)
            }
            await yieldTurn()
          }
        }
      }
      if (!usable(s)) return
      const buckets = new Map()
      for (const p of found.values()) {
        const key = `${bot.game?.dimension}:${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`
        if (!buckets.has(key)) buckets.set(key, [])
        buckets.get(key).push(p)
      }
      const threshold = readInt(env().BASE_ALERT_THRESHOLD, 4, 1, 4096)
      for (const [key, positions] of buckets) {
        if (positions.length < threshold || s.bases.has(key)) continue
        const counts = {}
        for (const p of positions) { const name = bot.blockAt(p)?.name || 'unknown'; counts[name] = (counts[name] || 0) + 1 }
        if (!Object.keys(counts).some(n => INDICATORS.includes(n) || n.endsWith('shulker_box'))) continue
        s.bases.add(key)
        if (s.bases.size > 5000) s.bases.delete(s.bases.values().next().value)
        const center = ['x', 'y', 'z'].map(axis => Math.round(positions.reduce((sum, p) => sum + p[axis], 0) / positions.length))
        log(s.id, `Possible base near ${center.join(', ')} — ${positions.length} storage blocks (${Object.entries(counts).map(([n, c]) => `${c}x ${n}`).join(', ')})`)
        pause(s)
      }
    } finally { s.scanning = false; if (scanOwner === s) scanOwner = null }
  }
  async function inventory(s) {
    if (s.inventoryBusy || !s.bot.inventory || !s.bot.registry) return
    s.inventoryBusy = true
    try {
      const bot = s.bot
      const offhand = bot.inventory.slots[45]
      const hasTotem = offhand?.name === 'totem_of_undying'
      if (s.hadTotem && !hasTotem) log(s.id, 'Totem consumed or removed from offhand.')
      s.hadTotem = hasTotem
      if (!hasTotem) {
        const totem = bot.inventory.items().find(i => i.name === 'totem_of_undying')
        if (totem) { await bot.equip(totem, 'off-hand'); s.hadTotem = true }
      }
      if (!usable(s) || bot.food == null || bot.food >= number('FOOD_EAT_THRESHOLD', 18, 0, 20)) return
      const foods = bot.inventory.items().filter(i => bot.registry.foodsByName?.[i.name])
      foods.sort((a, b) => (bot.registry.foodsByName[b.name].foodPoints || 0) - (bot.registry.foodsByName[a.name].foodPoints || 0))
      if (!foods.length) { if (!s.noFood) log(s.id, 'Hungry; no food in inventory.'); s.noFood = true; return }
      s.noFood = false
      await bot.equip(foods[0], 'hand')
      if (!usable(s)) return
      await bot.consume()
      if (alive(s)) log(s.id, `Ate ${foods[0].displayName || foods[0].name}`)
    } finally { s.inventoryBusy = false }
  }
  function players(s) {
    const fleet = new Set(Object.keys(bots).map(n => n.toLowerCase()))
    for (const [name, player] of Object.entries(s.bot.players || {})) {
      if (fleet.has(name.toLowerCase()) || !player.entity) continue
      const d = distance(s.bot.entity.position, player.entity.position)
      if (d > number('PLAYER_PROXIMITY_RADIUS', 32, 1, 256)) continue
      const previous = s.players.get(name)
      if (previous != null && now() - previous < ms('PLAYER_PROXIMITY_COOLDOWN_MS', 300000)) continue
      s.players.set(name, now())
      if (s.players.size > 1000) s.players.delete(s.players.keys().next().value)
      log(s.id, `Player nearby: ${name} (${d.toFixed(1)} blocks)`)
    }
  }
  function start(id) {
    if (sessions.has(id)) return { ok: false, error: 'Already roaming' }
    const entry = bots[id]
    if (!online(entry)) return { ok: false, error: 'Offline; skipped' }
    if (busy(entry) || entry.bot.currentWindow) return { ok: false, error: 'Busy; stop other routines first' }
    const s = { id, bot: entry.bot, timers: new Set(), bases: new Set(), players: new Map(), pauseUntil: 0, arrival: null }
    sessions.set(id, s)
    entry.rtpRunning = true
    s.teleport = () => { if (s.arrival) s.arrival.teleported = true }
    s.end = () => stop(id)
    s.bot.on('forcedMove', s.teleport)
    for (const event of ['end', 'kicked', 'death']) s.bot.on(event, s.end)
    log(id, 'Roam mode started: RTP, food/totems, base scans and nearby players; local logs only.')
    periodic(s, inventory, 'FOOD_CHECK_INTERVAL_MS', 5000)
    periodic(s, scan, 'BASE_SCAN_INTERVAL_MS', 12000)
    periodic(s, players, 'PLAYER_PROXIMITY_INTERVAL_MS', 5000)
    request(s)
    return { ok: true }
  }
  function stop(id) {
    const s = sessions.get(id)
    if (!s) return false
    sessions.delete(id)
    for (const t of s.timers) clearTimer(t)
    s.timers.clear()
    s.bot.removeListener('forcedMove', s.teleport)
    for (const event of ['end', 'kicked', 'death']) s.bot.removeListener(event, s.end)
    if (bots[id]?.bot === s.bot) bots[id].rtpRunning = false
    if (s.inventoryBusy) { try { s.bot.deactivateItem() } catch (_) {} }
    log(id, 'Roam mode stopped (restart explicitly with /start-rtp).')
    return true
  }
  return { start, stop, active: id => sessions.has(id), scan, sessions }
}
module.exports = { createRtpRoaming }
