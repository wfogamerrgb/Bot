#!/usr/bin/env node
'use strict'
// plan-routes — turn one roster into a STABLE fleet layout.
//
//   node plan-routes.js <roster-file> [--per-group 10] [--direct 20] [--bot-max 50]
//
// The roster file is one username per line (order irrelevant). The plan is
// derived from a hash of the name, not from its position, so the same roster
// always produces the same three groups and the same direct cohort — a new
// deployment or a re-run months later cannot shuffle every bot's exit IP.
//
// Output is `KEY=value` lines for the deploy env:
//
//   BOT_NAMES                   groups first, then the direct cohort, then the
//                               unassigned remainder (the replacement pool)
//   PROXY_GROUP_<N>_BOTS        ten names each (--per-group)
//   PROXY_GROUP_<N>_HOST/PORT   127.0.0.1 on 9050 / 9150 / 9250 — one Tor per group
//   DIRECT_MAX / BOT_MAX        ceiling so the direct cohort stays at --direct
//
// Nothing secret is written; login passwords are left to the existing env.
const crypto = require('crypto')
const fs = require('fs')

const args = process.argv.slice(2)
const file = args.find(arg => !arg.startsWith('--'))
const flag = (name, def) => {
  const index = args.indexOf('--' + name)
  if (index < 0) return def
  const value = Number(args[index + 1])
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} needs a non-negative integer`)
  return value
}
if (!file) {
  console.error('usage: node plan-routes.js <roster-file> [--per-group 10] [--direct 20] [--bot-max 50]')
  process.exit(2)
}

const perGroup = flag('per-group', 10)
const directCount = flag('direct', 20)
const botMax = flag('bot-max', 50)
const groupCount = 3
const ports = [9050, 9150, 9250]

const roster = []
const seen = new Set()
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const name = line.trim()
  if (!name || name.startsWith('#')) continue
  const key = name.toLowerCase()
  if (seen.has(key)) continue
  seen.add(key)
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error(`invalid username in roster: ${name}`)
  roster.push(name)
}
const needed = perGroup * groupCount + directCount
if (roster.length < needed) throw new Error(`roster has ${roster.length} names, ${needed} are needed`)

// Stable, seed-free ordering: sha1(lowercased name). Adding a name later only
// inserts it at its hashed position instead of shifting everyone else.
const rank = name => crypto.createHash('sha1').update(name.toLowerCase()).digest('hex')
const ordered = [...roster].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : a.localeCompare(b)))

const groups = []
for (let i = 0; i < groupCount; i++) groups.push(ordered.slice(i * perGroup, (i + 1) * perGroup))
const direct = ordered.slice(perGroup * groupCount, perGroup * groupCount + directCount)
const rest = ordered.slice(perGroup * groupCount + directCount)

// BOT_NAMES order is connect order: groups first (they always connect), then the
// direct cohort (the first --direct names that fit under DIRECT_MAX), then the
// spares that replace a banned direct bot.
const lines = [
  `BOT_NAMES=${[...groups.flat(), ...direct, ...rest].join(',')}`,
  `DIRECT_MAX=${directCount}`,
  `BOT_MAX=${botMax}`,
  `TOR_PORTS=${ports.join(' ')}`
]
groups.forEach((members, index) => {
  const n = index + 1
  lines.push(`PROXY_GROUP_${n}_BOTS=${members.join(',')}`)
  lines.push(`PROXY_GROUP_${n}_HOST=127.0.0.1`)
  lines.push(`PROXY_GROUP_${n}_PORT=${ports[index]}`)
  lines.push(`PROXY_GROUP_${n}_TYPE=socks5`)
})
console.log(lines.join('\n'))

// Report on stderr so stdout stays valid env.
console.error(`roster ${roster.length} → groups ${groups.map(g => g.length).join('/')}, direct ${direct.length}, spare ${rest.length}`)
