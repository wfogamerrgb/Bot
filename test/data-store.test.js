'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const store = require('../data-store')

test('first observation is a baseline and later observation calculates earnings and hourly rate', () => {
  const first = store.calculateProduction(undefined, 100, 1000)
  assert.equal(first.earned, null)
  assert.equal(first.ratePerHour, null)
  assert.equal(first.status, 'baseline')
  const second = store.calculateProduction({ balance: 100, recordedAt: 1000 }, 125, 3700)
  assert.equal(second.earned, 25)
  assert.equal(second.ratePerHour, 33333.333333333336)
  assert.equal(second.status, 'calculated')
})

test('N/A balance skips production calculation', () => {
  const result = store.calculateProduction({ balance: 100, recordedAt: 1000 }, null, 2000)
  assert.equal(result.earned, null)
  assert.equal(result.ratePerHour, null)
  assert.equal(result.status, 'N/A balance')
})

test('snapshot preserves bot and spawner rows plus lifetime totals', () => {
  const state = store.emptyState()
  store.upsertBot(state, { bot: 'A', rank: 'Member' })
  store.upsertSpawner(state, { bot: 'A', spawnerNumber: 1, earned: 4 })
  store.upsertSpawner(state, { bot: 'A', spawnerNumber: 2, earned: 6 })
  const snapshot = store.buildSnapshot(state, 0)
  assert.equal(snapshot.bots.length, 1)
  assert.equal(snapshot.spawners.length, 2)
  assert.deepEqual(snapshot.lifetime, { totalEarned: 10, samples: 2 })
})

test('webhook posts JSON payload', async () => {
  let request
  const response = await store.pushWebhook('https://example.test', { bots: [] }, async (url, options) => {
    request = { url, options }
    return { ok: true, status: 200 }
  })
  assert.equal(response.pushed, true)
  assert.equal(request.options.method, 'POST')
  assert.deepEqual(JSON.parse(request.options.body), { bots: [] })
})
