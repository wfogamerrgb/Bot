'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const dotenv = require('dotenv')
const { admissionRoutes, namesFromText } = require('./robot-login')
const { parseNameList } = require('./bot-controls')
const { WORDS } = require('./name-words')

// ── Themed username generation ──────────────────────────────────────────────
// Generated names must read like a real player handle, not like a bot roster:
// tech/sci-fi vocabulary (name-words.js), leetspeak, underscores and the odd
// typo. Minecraft usernames allow letters, digits and underscore only (3–16
// characters), so those are the only shapes produced. Trailing numbers stay
// 0–3 digits — "Hyp4r_P4cket", "SegvN0va7", "Seg0_F4ult_0x00" — instead of the
// old 4-digit serial that made every account look machine-made.
const LEET = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7', g: '9', b: '8' }
const HEX = '0123456789abcdef'
const SHORT_WORDS = WORDS.filter(word => word.length <= 7)
const keyOf = name => name.toLowerCase()
const cap = word => word.charAt(0).toUpperCase() + word.slice(1)

// Replace every occurrence of one letter with its leet form ("nova" → "n0va").
function leetify(word, randomInt) {
  const options = [...new Set(word.split(''))].filter(ch => LEET[ch])
  if (!options.length || randomInt(3) === 0) return word
  const target = options[randomInt(options.length)]
  return word.split('').map(ch => (ch === target ? LEET[ch] : ch)).join('')
}

// Subtle "typo": one dropped, doubled or swapped letter. Human misspellings
// are one of the few signals that separate a player handle from a generator.
function typo(word, randomInt) {
  if (word.length < 5 || randomInt(5) !== 0) return word
  const i = 1 + randomInt(word.length - 2)
  const kind = randomInt(3)
  if (kind === 0) return word.slice(0, i) + word.slice(i + 1)
  if (kind === 1) return word.slice(0, i) + word[i] + word.slice(i)
  return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2)
}

// 0–3 trailing digits, favouring no suffix at all.
function tailDigits(randomInt) {
  const roll = randomInt(10)
  if (roll < 5) return ''
  if (roll < 7) return String(randomInt(10))
  if (roll < 9) return String(randomInt(100)).padStart(2, '0')
  return String(randomInt(1000)).padStart(3, '0')
}

function hexTag(randomInt) {
  return '0x' + HEX[randomInt(16)] + HEX[randomInt(16)]
}

function generateName(randomInt) {
  for (let attempt = 0; attempt < 64; attempt++) {
    const first = typo(leetify(WORDS[randomInt(WORDS.length)], randomInt), randomInt)
    const pool = first.length >= 9 ? SHORT_WORDS : WORDS
    const second = typo(leetify(pool[randomInt(pool.length)], randomInt), randomInt)
    if (first === second) continue
    const camel = randomInt(3) !== 0
    const part = word => (camel ? cap(word) : word)
    // Sometimes no separator (SegvN0va), usually an underscore (Hyp4r_P4cket).
    const name = (randomInt(3) === 0 ? part(first) + part(second) : part(first) + '_' + part(second)) + (() => {
      const style = randomInt(10)
      if (style < 5) return tailDigits(randomInt)
      if (style >= 8) return '_' + hexTag(randomInt) // Seg0_F4ult_0x00
      return ''
    })()
    if (name.length > 16) continue
    // A leet word ending in a digit plus a numeric suffix can fuse into a
    // 4+ digit serial — exactly the bot-look being removed. Cap the run.
    const trimmed = name.replace(/\d+$/, run => run.slice(0, 3))
    if (trimmed.length < 3) continue
    return trimmed
  }
  return null
}

function generateNames(count, existing = [], randomInt = crypto.randomInt) {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Count must be between 1 and 100')
  const used = new Set(existing.map(keyOf)), names = []
  for (let attempt = 0; names.length < count && attempt < count * 2000; attempt++) {
    const name = generateName(randomInt)
    if (!name || used.has(keyOf(name))) continue
    used.add(keyOf(name)); names.push(name)
  }
  if (names.length !== count) throw new Error('Could not generate enough unique names')
  return names
}

function updateEnvText(text, updates) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const remaining = new Map(Object.entries(updates))
  const lines = text.split(/\r?\n/).map(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (!match || !Object.hasOwn(updates, match[1])) return line
    const key = match[1]
    remaining.delete(key)
    // Only username lists are written; preserve unrelated lines/credentials.
    // A null value deletes the line (used to retire BOT_DIRECT_<taken> keys).
    return updates[key] == null ? null : `${key}=${updates[key]}`
  }).filter(line => line !== null)
  while (lines.at(-1) === '') lines.pop()
  for (const [key, value] of remaining) {
    if (value == null) continue
    lines.push(`${key}=${value}`)
  }
  return lines.join(newline) + newline
}

// Shared atomic .env save: never clobber a concurrent edit, never leave the
// temporary credential file behind.
function saveEnvFile(file, text, updates, io) {
  const next = updateEnvText(text, updates)
  const temporary = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp'
  try {
    io.writeFileSync(temporary, next, { mode: 0o600, flag: 'wx' })
    // Avoid overwriting a concurrent editor's change between read and save.
    let current = ''
    try { current = io.readFileSync(file, 'utf8') } catch (err) { if (err.code !== 'ENOENT') throw err }
    if (current !== text) throw new Error('.env changed while generating; retry the command')
    io.renameSync(temporary, file)
  } finally { try { io.unlinkSync(temporary) } catch (err) { if (err.code !== 'ENOENT') throw err } }
}

function usedNames(config, { file, io, existing, blocked }) {
  return [...existing, ...blocked, ...parseNameList(config.BOT_NAMES), ...Object.entries(config).filter(([key]) => /^PROXY_GROUP_\d+_BOTS$/.test(key)).flatMap(([, value]) => parseNameList(value)),
    ...['robot.txt', 'removed.txt'].flatMap(name => {
      try { return namesFromText(io.readFileSync(path.join(path.dirname(file), name), 'utf8')) } catch (err) { if (err.code === 'ENOENT') return []; throw err }
    })]
}

// Auto-route weighting for /new-gen. The direct connection is the favourite
// route: 3 shares against every proxy group's 1 — "used 2x more of the time" —
// so with one proxy group the split is exactly 3/4 direct and 1/4 group, and
// each further group divides its own single share. The route furthest below
// its weighted share takes the next name (ties: direct first, then the lower
// group index), which keeps the ratio exact over any run length.
const DIRECT_SHARE = 3
const GROUP_SHARE = 1

function persistGeneratedBots({ file = path.join(__dirname, '.env'), env = process.env, existing = [], blocked = [], count = 1, group = 'auto', io = fs, randomInt = crypto.randomInt }) {
  let text = ''
  try { text = io.readFileSync(file, 'utf8') } catch (err) { if (err.code !== 'ENOENT') throw err }
  const disk = dotenv.parse(text), config = { ...env, ...disk }
  const routes = admissionRoutes(config).filter(Boolean)
  if (group !== 'auto' && group !== 'direct' && !routes.some(route => route.index === Number(group))) throw new Error('Proxy group must have a valid HOST/PORT/TYPE')
  const used = usedNames(config, { file, io, existing, blocked })
  const names = generateNames(count, used, randomInt)
  const updates = { BOT_NAMES: [...new Set([...parseNameList(config.BOT_NAMES), ...names])].join(',') }
  const groups = new Map(routes.map(route => [route.index, parseNameList(config[`PROXY_GROUP_${route.index}_BOTS`])]))
  // Roster names outside every group already ride the direct/default route,
  // so they seed the direct share before any new name is placed.
  const grouped = new Set([...groups.values()].flat().map(keyOf))
  let directCount = parseNameList(config.BOT_NAMES).filter(name => !grouped.has(keyOf(name))).length
  const assignments = []
  for (const name of names) {
    let selected
    if (group === 'auto') {
      const shares = [...groups].map(([index, members]) => ({ index, share: members.length / GROUP_SHARE }))
      if (groups.size) shares.push({ index: null, share: directCount / DIRECT_SHARE })
      selected = shares.length
        ? shares.sort((a, b) => a.share - b.share || (a.index === null ? -1 : b.index === null ? 1 : a.index - b.index))[0].index
        : null
    } else {
      selected = group === 'direct' ? null : Number(group)
    }
    if (selected != null) { groups.get(selected).push(name); updates[`PROXY_GROUP_${selected}_BOTS`] = groups.get(selected).join(',') }
    else if (group === 'direct' || (group === 'auto' && groups.size)) {
      // A direct pick is flagged like group=direct so it bypasses a global
      // PROXY_HOST too — "direct" has to mean direct. With no proxy groups at
      // all there is nothing to distribute against, so names keep riding the
      // default route (previous behaviour, unchanged).
      updates[`BOT_DIRECT_${name}`] = 'true'
      directCount++
    }
    assignments.push({ name, group: selected })
  }
  saveEnvFile(file, text, updates, io)
  for (const [key, value] of Object.entries(updates)) env[key] = value
  return { names, assignments }
}

// ── Taken-username replacement ──────────────────────────────────────────────
// When the server reports the generated username is owned by a real Minecraft
// account, retrying it can only fail again. Swap it for a fresh generated name
// in place: BOT_NAMES keeps the roster size, the proxy group keeps its route,
// and BOT_DIRECT_<taken> moves to BOT_DIRECT_<new>. Returns the replacement and
// where it was routed so the caller can connect it immediately.
function persistRegeneratedName({ file = path.join(__dirname, '.env'), env = process.env, taken, existing = [], blocked = [], io = fs, randomInt = crypto.randomInt }) {
  const victim = String(taken || '').trim()
  if (!/^[A-Za-z0-9_]{1,16}$/.test(victim)) throw new Error('Invalid taken username')
  let text = ''
  try { text = io.readFileSync(file, 'utf8') } catch (err) { if (err.code !== 'ENOENT') throw err }
  const disk = dotenv.parse(text), config = { ...env, ...disk }
  const used = usedNames(config, { file, io, existing, blocked })
  used.push(victim)
  const [replacement] = generateNames(1, used, randomInt)
  const sameKey = name => keyOf(name) === keyOf(victim)
  const swap = names => names.map(name => (sameKey(name) ? replacement : name))
  const updates = {}
  const roster = parseNameList(config.BOT_NAMES)
  updates.BOT_NAMES = (roster.some(sameKey) ? swap(roster) : [...roster, replacement]).join(',')
  let group = null
  for (const [key, value] of Object.entries(config)) {
    const match = key.match(/^PROXY_GROUP_(\d+)_BOTS$/)
    if (!match) continue
    const members = parseNameList(value)
    if (!members.some(sameKey)) continue
    group = Number(match[1])
    updates[key] = swap(members).join(',')
  }
  let direct = false
  for (const key of Object.keys(config)) {
    const match = key.match(/^BOT_DIRECT_(.+)$/)
    if (!match || !sameKey(match[1])) continue
    updates[key] = null // delete the retired key
    updates[`BOT_DIRECT_${replacement}`] = 'true'
    direct = true
  }
  saveEnvFile(file, text, updates, io)
  for (const [key, value] of Object.entries(updates)) {
    if (value == null) delete env[key]
    else env[key] = value
  }
  return { name: replacement, taken: victim, group, direct }
}

module.exports = { generateNames, updateEnvText, saveEnvFile, persistGeneratedBots, persistRegeneratedName }
