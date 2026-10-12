'use strict'

const TRIGGER_MESSAGE = "Bob, help me? I'm in trouble. Code 23642"
const REACH = 4.5
const DUPLICATE_WINDOW_MS = 2000
const CLAIM_WINDOW_MS = 5000

// Right-click only: no pathfinder, movement controls, warps, digging, or chat.
// activateBlock may turn the bot's view, but does not move its position.
function createPearlStasis ({ getBots, logFor = () => {}, now = Date.now }) {
  const attached = new WeakSet()
  const claims = new Map()
  let lastTrigger = -Infinity
  const clean = text => String(text ?? '').replace(/\u00a7./g, '')

  function ready (entry) {
    const bot = entry?.bot
    return bot?.entity?.position && (!entry.connectionState || entry.connectionState === 'online') &&
      !entry.authPending && entry.authenticated !== false && !bot.inConfigurationPhase &&
      !bot._client?.ended && (!bot._client?.state || bot._client.state === 'play') &&
      !bot.currentWindow && !bot.controlState?.sneak
  }

  function trapdoor (block) {
    // Iron trapdoors cannot be opened by right-clicking; don't pretend otherwise.
    return block && block.name !== 'iron_trapdoor' && /(?:^|_)trapdoor$/.test(block.name)
  }

  function nearest (bot) {
    const origin = bot.entity.position
    const eye = origin.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
    const positions = bot.findBlocks({ matching: trapdoor, point: origin, maxDistance: 6, count: 64 })
    return positions.map(position => bot.blockAt(position))
      .filter(block => trapdoor(block) && eye.distanceTo(block.position.offset(0.5, 0.5, 0.5)) <= REACH && bot.canSeeBlock(block))
      .sort((a, b) => eye.distanceTo(a.position.offset(0.5, 0.5, 0.5)) - eye.distanceTo(b.position.offset(0.5, 0.5, 0.5)))[0]
  }

  async function trigger () {
    const time = now()
    if (time - lastTrigger < DUPLICATE_WINDOW_MS) return []
    lastTrigger = time
    for (const [key, expires] of claims) if (expires <= time) claims.delete(key)
    const jobs = []
    for (const [id, entry] of Object.entries(getBots())) {
      if (!ready(entry)) continue
      const bot = entry.bot
      try {
        const block = nearest(bot)
        if (!block) {
          logFor(id, '[stasis] No visible wooden trapdoor within reach; staying put.')
          continue
        }
        const p = block.position
        const key = JSON.stringify([entry.host, entry.port, bot.game?.dimension, p.x, p.y, p.z])
        // Every bot sees the same chat. Only ONE click per shared trapdoor:
        // a second bot must not toggle it straight back to its previous state.
        if (claims.has(key)) continue
        claims.set(key, time + CLAIM_WINDOW_MS)
        jobs.push((async () => {
          try {
            const fresh = bot.blockAt(p)
            if (getBots()[id] !== entry || !ready(entry) || !trapdoor(fresh) || !bot.canSeeBlock(fresh)) return 'skipped'
            await bot.activateBlock(fresh)
            logFor(id, '[stasis] Right-click sent to nearby trapdoor; no movement requested.')
            return 'clicked'
          } catch (err) {
            // No automatic retries: a lost acknowledgement must not double-toggle.
            logFor(id, `[stasis] Trapdoor click failed: ${err.message}`)
            return 'failed'
          }
        })())
      } catch (err) {
        logFor(id, `[stasis] Trapdoor search failed: ${err.message}`)
      }
    }
    return Promise.all(jobs)
  }

  function onMessage (id, message, position) {
    if (!getBots()[id] || position === 2 || position === 'game_info') return Promise.resolve([])
    const text = clean(message)
    // Accept an exact message body, plus ordinary Minecraft/player chat wrappers.
    // Never match a substring, a changed code, or a quoted/extended message.
    const player = text.match(/^(?:<[A-Za-z0-9_]{1,16}> |[A-Za-z0-9_]{1,16}: )(.*)$/)
    return (player ? player[1] : text) === TRIGGER_MESSAGE ? trigger() : Promise.resolve([])
  }

  function attach (bot, id) {
    if (attached.has(bot)) return
    attached.add(bot)
    bot.on('messagestr', (message, position) => {
      if (getBots()[id]?.bot === bot) void onMessage(id, message, position)
    })
    // Structured chat handles server-rendered prefixes without fuzzy text matching.
    bot.on('chat', (_username, message) => {
      if (getBots()[id]?.bot === bot && clean(message) === TRIGGER_MESSAGE) void trigger()
    })
  }

  return { attach, onMessage }
}

module.exports = { TRIGGER_MESSAGE, createPearlStasis }
