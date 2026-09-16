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
  assert.equal(request.url, 'https://example.test', 'no secret means no query parameter')
})

// Apps Script web apps never expose request headers, so the shared secret has to
// ride along in the URL (e.parameter.secret) and the JSON body.
test('webhook sends the shared secret as a query parameter and a body field', async () => {
  let request
  await store.pushWebhook('https://script.test/exec?foo=1', { bots: [] }, async (url, options) => {
    request = { url, options }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, written: { Bots: 0, Spawners: 0, Lifetime: 0 } }) }
  }, { secret: 's3cret value' })
  assert.equal(request.url, 'https://script.test/exec?foo=1&secret=s3cret%20value')
  assert.equal(JSON.parse(request.options.body).secret, 's3cret value')
})

test('webhook reports the rows the Apps Script endpoint actually wrote', async () => {
  const response = await store.pushWebhook('https://script.test/exec', { bots: [] }, async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, written: { Bots: 3, Spawners: 8, Lifetime: 1 } })
  }))
  assert.equal(response.pushed, true)
  assert.deepEqual(response.response.written, { Bots: 3, Spawners: 8, Lifetime: 1 })
})

// A web app that is not deployed with "Who has access: Anyone" answers with an
// HTML sign-in page and HTTP 200 — the old code reported a successful push while
// the spreadsheet was never touched.
test('webhook rejects a non-JSON response instead of claiming success', async () => {
  await assert.rejects(
    store.pushWebhook('https://script.test/exec', { bots: [] }, async () => ({
      ok: true,
      status: 200,
      text: async () => '<!DOCTYPE html><html><body>Sign in to continue</body></html>'
    })),
    /non-JSON content/)
})

test('webhook surfaces errors reported by the Apps Script endpoint', async () => {
  await assert.rejects(
    store.pushWebhook('https://script.test/exec', { bots: [] }, async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: false, errors: ['Bots: cannot write to sheet'] })
    })),
    /Bots: cannot write to sheet/)
})

test('webhook applies the configured timeout', async () => {
  let request
  await store.pushWebhook('https://script.test/exec', { bots: [] }, async (url, options) => {
    request = { url, options }
    return { ok: true, status: 200 }
  }, { timeoutMs: 5000 })
  assert.ok(request.options.signal instanceof AbortSignal, 'a timeout must abort the request')
})

test('webhook request failures carry the reason', async () => {
  await assert.rejects(
    store.pushWebhook('https://script.test/exec', { bots: [] }, async () => { throw new Error('getaddrinfo ENOTFOUND script.test') }),
    /data webhook request failed: getaddrinfo ENOTFOUND/)
})

test('withSecret only appends when a secret is set', () => {
  assert.equal(store.withSecret('https://x/exec', ''), 'https://x/exec')
  assert.equal(store.withSecret('https://x/exec', 'a b'), 'https://x/exec?secret=a%20b')
  assert.equal(store.withSecret('https://x/exec?v=1', 'k'), 'https://x/exec?v=1&secret=k')
})
