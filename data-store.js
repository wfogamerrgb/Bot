'use strict'

const fs = require('fs')
const path = require('path')

function emptyState () {
  return { version: 1, updatedAt: null, bots: {}, spawners: {}, events: [] }
}

function loadState (file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { ...emptyState(), ...parsed, bots: parsed.bots || {}, spawners: parsed.spawners || {}, events: parsed.events || [] }
  } catch (_) { return emptyState() }
}

function saveState (file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

function calculateProduction (previous, balance, now = Date.now()) {
  if (!Number.isFinite(balance)) return { earned: null, ratePerHour: null, status: 'N/A balance' }
  const earned = Number.isFinite(previous?.balance) ? balance - previous.balance : null
  const elapsedMs = Number.isFinite(previous?.recordedAt) ? now - previous.recordedAt : null
  const ratePerHour = earned !== null && elapsedMs > 0 ? earned * 3600000 / elapsedMs : null
  return { earned, ratePerHour, status: ratePerHour === null ? 'baseline' : 'calculated' }
}

function upsertBot (state, row) {
  state.bots[row.bot] = { ...state.bots[row.bot], ...row }
}

function upsertSpawner (state, row) {
  const key = `${row.bot}:${row.spawnerNumber}`
  state.spawners[key] = { ...state.spawners[key], ...row }
}

function buildSnapshot (state, now = Date.now()) {
  return {
    version: state.version,
    generatedAt: new Date(now).toISOString(),
    bots: Object.values(state.bots),
    spawners: Object.values(state.spawners),
    lifetime: Object.values(state.spawners).reduce((out, row) => {
      const lifetime = Number.isFinite(row.lifetimeEarned) ? row.lifetimeEarned : row.earned
      if (Number.isFinite(lifetime)) {
        out.totalEarned += lifetime
        out.samples += 1
      }
      return out
    }, { totalEarned: 0, samples: 0 })
  }
}

// Appends the shared secret as a query parameter. Apps Script web apps expose
// query parameters (e.parameter) but never request headers, so the secret has to
// travel in the URL and/or the JSON body.
function withSecret (url, secret) {
  if (!secret) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}secret=${encodeURIComponent(secret)}`
}

// POSTs a snapshot to the configured webhook (normally a Google Apps Script
// doPost). The response body is parsed and validated, because a web app that is
// not deployed with "Who has access: Anyone" answers with an HTML login page and
// HTTP 200 — the push looked successful while the sheet never updated.
//
// Resolves with { pushed, status, response } where `response` is the parsed JSON
// body (null when the endpoint returned no body, e.g. in unit tests).
async function pushWebhook (url, payload, fetchImpl = globalThis.fetch, { secret = '', timeoutMs = 0 } = {}) {
  if (!url) return { pushed: false, skipped: true, response: null }
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable')

  const body = JSON.stringify(secret ? { ...payload, secret } : payload)
  const options = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  }
  if (timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    options.signal = AbortSignal.timeout(timeoutMs)
  }

  let response
  try {
    response = await fetchImpl(withSecret(url, secret), options)
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
    const reason = timedOut ? `timed out after ${timeoutMs}ms` : (err && err.message ? err.message : String(err))
    throw new Error(`data webhook request failed: ${reason}`)
  }
  if (!response || !response.ok) throw new Error(`data webhook returned HTTP ${response ? response.status : 'no response'}`)

  const text = typeof response.text === 'function' ? await response.text() : ''
  let parsed = null
  if (text && text.trim()) {
    try {
      parsed = JSON.parse(text)
    } catch (_) {
      const preview = text.trim().replace(/\s+/g, ' ').slice(0, 140)
      throw new Error(`data webhook answered with non-JSON content (${preview}) — check that the Apps Script web app is deployed with "Execute as: me" and "Who has access: Anyone"`)
    }
  }
  if (parsed && parsed.ok === false) {
    const detail = Array.isArray(parsed.errors) && parsed.errors.length ? parsed.errors.join('; ') : 'no detail reported'
    throw new Error(`Apps Script reported a failure: ${detail}`)
  }
  return { pushed: true, status: response.status, response: parsed }
}

module.exports = { emptyState, loadState, saveState, calculateProduction, upsertBot, upsertSpawner, buildSnapshot, pushWebhook, withSecret }
