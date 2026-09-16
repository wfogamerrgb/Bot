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

async function pushWebhook (url, payload, fetchImpl = globalThis.fetch) {
  if (!url) return { pushed: false, skipped: true }
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable')
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!response.ok) throw new Error(`data webhook returned HTTP ${response.status}`)
  return { pushed: true, status: response.status }
}

module.exports = { emptyState, loadState, saveState, calculateProduction, upsertBot, upsertSpawner, buildSnapshot, pushWebhook }
