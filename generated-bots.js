'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const dotenv = require('dotenv')
const { admissionRoutes, namesFromText } = require('./robot-login')
const { parseNameList } = require('./bot-controls')
const prefixes = ['Amber', 'Azure', 'Birch', 'Cobalt', 'Crimson', 'Dusk', 'Echo', 'Frost', 'Iron', 'Jade', 'Lunar', 'Moss', 'Nova', 'Onyx', 'Pixel', 'Quartz', 'Rune', 'Silver', 'Stone', 'Willow']
const suffixes = ['Badger', 'Crafter', 'Falcon', 'Fox', 'Golem', 'Hawk', 'Miner', 'Otter', 'Panda', 'Raven', 'Scout', 'Spruce', 'Wolf']
const keyOf = name => name.toLowerCase()
function generateNames(count, existing = [], randomInt = crypto.randomInt) {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Count must be between 1 and 100')
  const used = new Set(existing.map(keyOf)), names = []
  for (let attempt = 0; names.length < count && attempt < count * 1000; attempt++) {
    const name = `${prefixes[randomInt(prefixes.length)]}${suffixes[randomInt(suffixes.length)]}${randomInt(10000).toString().padStart(4, '0')}`
    if (name.length > 16 || used.has(keyOf(name))) continue
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
    return `${key}=${updates[key]}`
  })
  while (lines.at(-1) === '') lines.pop()
  for (const [key, value] of remaining) lines.push(`${key}=${value}`)
  return lines.join(newline) + newline
}
function persistGeneratedBots({ file = path.join(__dirname, '.env'), env = process.env, existing = [], blocked = [], count = 1, group = 'auto', io = fs, randomInt = crypto.randomInt }) {
  let text = ''
  try { text = io.readFileSync(file, 'utf8') } catch (err) { if (err.code !== 'ENOENT') throw err }
  const disk = dotenv.parse(text), config = { ...env, ...disk }
  const routes = admissionRoutes(config).filter(Boolean)
  if (group !== 'auto' && group !== 'direct' && !routes.some(route => route.index === Number(group))) throw new Error('Proxy group must have a valid HOST/PORT/TYPE')
  const used = [...existing, ...blocked, ...parseNameList(config.BOT_NAMES), ...Object.entries(config).filter(([key]) => /^PROXY_GROUP_\d+_BOTS$/.test(key)).flatMap(([, value]) => parseNameList(value))]
  for (const name of ['robot.txt', 'removed.txt']) {
    try { used.push(...namesFromText(io.readFileSync(path.join(path.dirname(file), name), 'utf8'))) } catch (err) { if (err.code !== 'ENOENT') throw err }
  }
  const names = generateNames(count, used, randomInt)
  const updates = { BOT_NAMES: [...new Set([...parseNameList(config.BOT_NAMES), ...names])].join(',') }
  const groups = new Map(routes.map(route => [route.index, parseNameList(config[`PROXY_GROUP_${route.index}_BOTS`])]))
  const assignments = []
  for (const name of names) {
    const selected = group === 'direct' ? null : group === 'auto' ? [...groups.keys()].sort((a, b) => groups.get(a).length - groups.get(b).length || a - b)[0] ?? null : Number(group)
    if (selected != null) { groups.get(selected).push(name); updates[`PROXY_GROUP_${selected}_BOTS`] = groups.get(selected).join(',') }
    else if (group === 'direct') updates[`BOT_DIRECT_${name}`] = 'true'
    assignments.push({ name, group: selected })
  }
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
  for (const [key, value] of Object.entries(updates)) env[key] = value
  return { names, assignments }
}
module.exports = { generateNames, updateEnvText, persistGeneratedBots }
