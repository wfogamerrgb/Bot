'use strict'
const { tokenizeDumpArgs, parseSleepDuration } = require('./bot-controls')

function parseOptions (text, defaults) {
  const out = { ...defaults }
  const terms = []
  const tokens = tokenizeDumpArgs(text)
  if (String(text).trim() && !tokens.length) throw Error('An empty item filter is unsafe; supply a non-empty match term.')
  for (const token of tokens) {
    const match = !token.quoted && token.text.match(/^(duration|cooldown|mode|scope)=(.*)$/i)
    if (!match) { terms.push(token.text); continue }
    const [, rawKey, value] = match
    const key = rawKey.toLowerCase()
    if (key === 'duration' || key === 'cooldown') {
      if (!/^\d+(?:\.\d+)?(?:ms|s|min|h)?$/i.test(value)) throw Error(`Invalid ${key}; use e.g. 60s or 10000ms.`)
      const ms = parseSleepDuration(value)
      if (!(ms >= (key === 'cooldown' ? 100 : 1)) || ms > 86400000) throw Error(`${key} must be ${key === 'cooldown' ? '100ms' : '1ms'}–24h.`)
      out[key + 'Ms'] = ms
    } else out[key] = value.toLowerCase()
  }
  if (terms.length) out.terms = terms
  if (!['duration', 'once', 'until-stop'].includes(out.mode)) throw Error('mode=duration|once|until-stop')
  if (!['all', 'inventory', 'gui'].includes(out.scope)) throw Error('scope=all|inventory|gui')
  if (!Array.isArray(out.terms) || !out.terms.length || out.terms.some(term => !String(term).trim())) throw Error('An empty item filter is unsafe; supply a non-empty match term.')
  return out
}

function createSpawnerDrop ({ bots, log, online, matches, defaults, reach = 4.5, blockName = 'spawner', now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const runs = new Map()
  function stop (id, reason = 'cancelled') {
    const run = runs.get(id)
    if (!run) return false
    run.cancelled = true
    run.reason = reason
    for (const cancel of [...run.waits]) cancel()
    return true
  }
  async function start (id, opts) {
    const entry = bots[id], bot = entry?.bot
    if (!online(entry)) throw Error('Bot is disconnected or not spawned.')
    if (runs.has(id)) throw Error('Already running; /spawner-drop stop first.')
    if (entry.inDumpRoutine || entry.inCrateRoutine || entry.inAppleRoutine || entry.spawnerRoutineRunning || entry.crateLoopRunning || entry.shardshopLoopRunning) throw Error('Stop the other inventory routine first.')
    if (entry.manualMode) throw Error('Stop manual mode before starting /spawner-drop.')
    if (bot.currentWindow) throw Error('Close the existing window first; this routine opens its own spawner GUI.')
    const targetId = bot.registry?.blocksByName?.[blockName]?.id
    if (targetId === undefined) throw Error(`Unknown block ${blockName}.`)
    const positions = bot.findBlocks({ matching: targetId, maxDistance: reach, count: 32 })
    positions.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b))
    const target = positions[0] && bot.blockAt(positions[0])
    if (!target) throw Error(`No ${blockName} in reach (${reach} blocks); this routine never walks.`)
    const run = { cancelled: false, waits: new Set(), dropped: 0, items: 0 }
    runs.set(id, run)
    entry.spawnerDropRunning = true
    const previous = entry.inSpawnerRoutine
    entry.inSpawnerRoutine = true
    const deadline = opts.mode === 'until-stop' ? Infinity : now() + opts.durationMs
    const alive = () => !run.cancelled && bots[id] === entry && online(entry) && now() < deadline
    function wait (ms) {
      return new Promise(resolve => {
        const cancel = () => { clearTimer(timer); run.waits.delete(cancel); resolve() }
        const timer = setTimer(cancel, ms)
        run.waits.add(cancel)
      })
    }
    // In-flight game operations cannot be unsent. Stop/deadline never starts a
    // subsequent action, even if an acknowledgement arrives late.
    async function operation (fn) {
      let timer, cancel
      try {
        return await Promise.race([
          Promise.resolve().then(() => {
            if (!alive()) throw Error(run.reason || 'Duration ended before dispatch.')
            return fn()
          }),
          new Promise((_, reject) => {
            cancel = () => reject(Error(run.reason || 'cancelled'))
            run.waits.add(cancel)
            timer = setTimer(() => reject(Error('Server acknowledgement timed out.')), Math.max(1, Math.min(5000, deadline - now())))
          })
        ])
      } finally { clearTimer(timer); run.waits.delete(cancel) }
    }
    let ownedWindow = null
    // Only the first window opened for this activation belongs to the run.
    // Never adopt a later unrelated GUI just because it emits windowOpen.
    const trackWindow = window => { if (!ownedWindow) ownedWindow = window }
    bot.on('windowOpen', trackWindow)
    try {
      bot.pathfinder?.stop?.()
      bot.clearControlStates?.()
      await operation(() => bot.lookAt(target.position.offset(0.5, 0.5, 0.5), false))
      if (!alive()) return
      log(id, `Spawner drop: ${opts.terms.join(' OR ')}; ${opts.mode}, ${opts.cooldownMs}ms per whole stack, scope=${opts.scope}. Existing matching stacks are included. /spawner-drop stop cancels.`)
      await operation(() => bot.activateBlock(target))
      const openDeadline = Math.min(deadline, now() + 5000)
      while (alive() && !bot.currentWindow && now() < openDeadline) await wait(100)
      if (!alive()) return
      if (!bot.currentWindow) throw Error('Spawner did not open a GUI within 5 seconds.')
      if (bot.currentWindow !== ownedWindow) throw Error('Spawner window changed while opening; refusing to adopt a different GUI.')
      const initialSlots = opts.mode === 'once' ? new Set(ownedWindow.slots.map((item, slot) => item && matches(item, opts.terms) ? slot : -1).filter(slot => slot >= 0)) : null
      while (alive()) {
        const win = bot.currentWindow
        if (!win || win !== ownedWindow) throw Error('Spawner window closed or changed; stopped to avoid touching a different GUI.')
        const slot = win.slots.findIndex((item, index) => {
          if (!item || !matches(item, opts.terms) || (initialSlots && !initialSlots.has(index))) return false
          const inventory = index >= win.inventoryStart && index < win.inventoryEnd
          return opts.scope === 'all' || (opts.scope === 'inventory' ? inventory : !inventory)
        })
        if (slot < 0) {
          if (opts.mode === 'once') break
          await wait(Math.min(250, deadline - now()))
          continue
        }
        const item = win.slots[slot], count = item.count, type = item.type
        const client = bot._client
        if (!client?.on) throw Error('Cannot verify server inventory updates; refusing an unverified drop.')
        const Item = require('prismarine-item')(bot.registry)
        let confirmed = false, rejected = false
        const inspect = raw => {
          try {
            const authoritative = raw == null ? null : Item.fromNotch(raw)
            if (!authoritative || authoritative.type !== type) confirmed = true
            else rejected = true // a partial reduction is not a whole-stack confirmation
          } catch (err) {
            rejected = true
            log(id, `Could not decode server drop confirmation: ${err.message}`, true)
          }
        }
        const onSlot = packet => { if (packet.windowId === win.id && packet.slot === slot) inspect(packet.item) }
        const onItems = packet => { if (packet.windowId === win.id && packet.items && slot < packet.items.length) inspect(packet.items[slot]) }
        // 1.16 and older have explicit transaction acknowledgements. Modern
        // mineflayer mutates slots optimistically BEFORE it sends a click, so a
        // local slot change is NOT proof that a GUI plugin allowed the drop.
        client.on('set_slot', onSlot)
        client.on('window_items', onItems)
        try {
          // Mode 4 button 1 throws a whole stack without selecting a cursor item.
          await operation(() => bot.clickWindow(slot, 1, 4))
          // Old protocols: mineflayer's promise matches the precise action ID
          // and rejects a negative acknowledgement. Unrelated raw transaction
          // packets must not confirm this drop.
          if (bot.supportFeature?.('transactionPacketExists')) confirmed = true
          if (!alive()) break
          const confirmDeadline = Math.min(deadline, now() + 3000)
          while (alive() && bot.currentWindow === win && !confirmed && !rejected && now() < confirmDeadline) await wait(100)
          if (!alive()) break
          if (bot.currentWindow !== win) throw Error('Window changed while confirming drop.')
          if (!confirmed || rejected) throw Error(`Slot ${slot} drop not confirmed by server; server may reject GUI drops or omit acknowledgements. No automatic retry.`)
          run.dropped++
          run.items += count
          initialSlots?.delete(slot)
        } finally {
          client.removeListener('set_slot', onSlot)
          client.removeListener('window_items', onItems)
        }
        await wait(Math.min(opts.cooldownMs, deadline - now()))
      }
    } catch (err) {
      if (!run.cancelled) log(id, `Spawner drop failed: ${err.message}`, true)
    } finally {
      bot.removeListener('windowOpen', trackWindow)
      if (ownedWindow && bot.currentWindow === ownedWindow) {
        try { bot.closeWindow(ownedWindow) } catch (err) { log(id, `Could not close spawner GUI: ${err.message}`, true) }
      }
      entry.inSpawnerRoutine = previous
      entry.spawnerDropRunning = false
      runs.delete(id)
      log(id, `Spawner drop stopped (${run.reason || 'finished'}): ${run.dropped} confirmed stack(s), ${run.items} item(s).`)
    }
  }
  async function route (id, text) {
    if (text.trim().toLowerCase() === 'stop') { log(id, stop(id) ? 'Stopping spawner drop.' : 'No spawner drop running.'); return true }
    try { await start(id, parseOptions(text, defaults())) } catch (err) { log(id, `Spawner drop: ${err.message}`, true) }
    return true
  }
  return { route, stop, start }
}
module.exports = { parseOptions, createSpawnerDrop }
