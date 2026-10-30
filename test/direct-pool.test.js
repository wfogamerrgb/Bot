'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { groupedNames, isDirectRoute, directPool, directStatus, mayConnectDirect, nextDirectCandidate } = require('../direct-pool')

// Ten bots per group, three groups, the rest direct — the deployed shape.
const groupA = Array.from({ length: 10 }, (_, i) => `G1_${i}`)
const groupB = Array.from({ length: 10 }, (_, i) => `G2_${i}`)
const groupC = Array.from({ length: 10 }, (_, i) => `G3_${i}`)
const direct = Array.from({ length: 40 }, (_, i) => `D_${i}`)
const config = {
  BOT_NAMES: [...groupA, ...groupB, ...groupC, ...direct].join(','),
  PROXY_GROUP_1_BOTS: groupA.join(','),
  PROXY_GROUP_1_HOST: 'localhost',
  PROXY_GROUP_1_PORT: '9050',
  PROXY_GROUP_2_BOTS: groupB.join(','),
  PROXY_GROUP_2_HOST: 'localhost',
  PROXY_GROUP_2_PORT: '9150',
  PROXY_GROUP_3_BOTS: groupC.join(','),
  PROXY_GROUP_3_HOST: 'localhost',
  PROXY_GROUP_3_PORT: '9250'
}

test('group membership is by bot list, and everything else is direct', () => {
  assert.equal(groupedNames(config).size, 30)
  assert.equal(isDirectRoute('G2_3', config), false)
  assert.equal(isDirectRoute('D_7', config), true)
  // BOT_DIRECT_<name> wins over a group list, exactly like the connect path.
  assert.equal(isDirectRoute('D_7', { ...config, BOT_DIRECT_D_7: 'true' }), true)
  assert.equal(isDirectRoute('G2_3', { ...config, BOT_DIRECT_G2_3: 'true' }), true)
  // Unknown names and junk are not silently counted as direct bots.
  assert.equal(isDirectRoute('not_in_roster', config), true)
  assert.deepEqual(directPool({ BOT_NAMES: 'A,B,A,b' }), ['A', 'B'])
})

test('global fallback and hostless groups use the actual fallback route', () => {
  const remote = { BOT_NAMES: 'A,B', PROXY_HOST: 'proxy.example', PROXY_GROUP_1_BOTS: 'A' }
  assert.equal(isDirectRoute('A', remote), false)
  assert.equal(isDirectRoute('B', remote), false)
  assert.equal(isDirectRoute('B', { ...remote, BOT_DIRECT_B: 'true' }), true)
  assert.equal(isDirectRoute('A', { ...remote, PROXY_HOST: '' }), true)
})

test('the pool is the direct roster in BOT_NAMES order — stable across restarts', () => {
  assert.deepEqual(directPool(config), direct)
  const shuffledNames = [...direct].reverse().join(',') + ',' + groupA.join(',')
  assert.deepEqual(directPool({ ...config, BOT_NAMES: shuffledNames }), [...direct].reverse())
})

test('directStatus counts slots, bans and the all-banned verdict', () => {
  const rows = [
    ...direct.slice(0, 5).map(id => ({ id, online: true })),
    ...direct.slice(5, 7).map(id => ({ id, online: false, banned: true })),
    { id: 'D_7', online: false, connecting: true },
    { id: 'G1_0', online: true }
  ]
  const status = directStatus({ config, rows, limit: 20 })
  assert.equal(status.poolSize, 40)
  assert.equal(status.live, 6, '5 online plus 1 connecting — a banned entry holds no slot')
  assert.equal(status.connected, 5)
  assert.equal(status.banned, 2)
  assert.equal(status.usable, 38)
  assert.equal(status.freeSlots, 14)
  assert.equal(status.allBanned, false)

  // Every name on the route banned (active bans or the removed list) is the
  // only thing that is allowed to call the route dead.
  const dead = direct.map(id => ({ id, online: false, banned: true }))
  const deadStatus = directStatus({ config, rows: dead, limit: 20 })
  assert.equal(deadStatus.allBanned, true)
  assert.equal(deadStatus.usable, 0)
  // An empty pool is not "all banned" — there is nothing to be banned.
  assert.equal(directStatus({ config: { BOT_NAMES: '' }, rows: [], limit: 20 }).allBanned, false)
  // A removed (permanently retired) name is unusable even without a ban flag.
  const removedStatus = directStatus({ config, rows: direct.map(id => ({ id, removed: true })), limit: 20 })
  assert.equal(removedStatus.allBanned, true, 'the removed list counts as unusable')
})

test('the direct ceiling blocks new names but never a reconnect', () => {
  const full = direct.slice(0, 20).map(id => ({ id, online: true }))
  const blocked = mayConnectDirect({ name: 'D_20', config, rows: full, limit: 20 })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /DIRECT_MAX=20/)
  // A banned bot frees its slot: its entry remains, its connection does not.
  const replaced = full.map((row, i) => (i === 0 ? { ...row, online: false, banned: true } : row))
  assert.equal(mayConnectDirect({ name: 'D_20', config, rows: replaced, limit: 20 }).ok, true, 'a ban frees the slot for the replacement')
  // A grouped bot is never subject to the direct ceiling.
  assert.equal(mayConnectDirect({ name: 'G1_0', config, rows: full, limit: 20 }).ok, true)
  // Reconnecting an existing direct bot is not a new bot.
  assert.equal(mayConnectDirect({ name: 'D_3', config, rows: full, limit: 20 }).ok, true)
  assert.equal(mayConnectDirect({ name: 'D_20', config, rows: [...full, { id: 'D_20', online: false }], limit: 20 }).ok, false, 'offline entries cannot bypass the cap')
  // One slot free is enough for the next name.
  assert.equal(mayConnectDirect({ name: 'D_20', config, rows: full.slice(0, 19), limit: 20 }).ok, true)
})

test('a banned direct bot is replaced by the next unused direct name', () => {
  const rows = direct.slice(0, 20).map((id, i) => ({ id, online: i !== 0, banned: i === 0 }))
  const next = nextDirectCandidate({ config, rows })
  assert.equal(next, 'D_20', 'roster order, first name with no entry')
  // Names the caller must not touch are skipped, and a full pool has no answer.
  assert.equal(nextDirectCandidate({ config, rows, blocked: ['d_20', 'D_21'] }), 'D_22')
  const all = direct.map(id => ({ id, online: true }))
  assert.equal(nextDirectCandidate({ config, rows: all }), null)
  // Grouped bots are never offered as a direct replacement.
  assert.equal(nextDirectCandidate({ config: { ...config, BOT_NAMES: [...groupA, ...groupB].join(',') }, rows: [] }), null)
})
