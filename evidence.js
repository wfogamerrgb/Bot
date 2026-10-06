'use strict'

function createEvidenceStore ({ file, fs = require('fs'), now = Date.now } = {}) {
  let state = { bots: {} }
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (loaded && loaded.bots && typeof loaded.bots === 'object') state = loaded
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const pending = new Map()
  const row = id => state.bots[id] || (state.bots[id] = { connections: [], deaths: [], dumps: [] })
  function save () {
    fs.mkdirSync(require('path').dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
    fs.renameSync(tmp, file)
  }
  function record (id, kind, detail) {
    const list = row(id)[kind] || (row(id)[kind] = [])
    list.push({ t: now(), ...detail })
    list.splice(0, Math.max(0, list.length - (kind === 'dumps' ? 3 : 20)))
    save()
    return list[list.length - 1]
  }
  function startDump (id, detail) {
    const dump = record(id, 'dumps', { ...detail, status: 'running', messages: [] })
    pending.set(id, dump)
    return dump
  }
  function captureDumpLine (id, text) {
    const dump = pending.get(id)
    if (!dump) return
    dump.messages.push(String(text).replace(/\{[^{}]*\}/g, '').slice(0, 2000))
    dump.messages.splice(0, Math.max(0, dump.messages.length - 30))
  }
  function finishDump (id, status = 'finished') {
    const dump = pending.get(id)
    if (!dump) return
    dump.finishedAt = now()
    dump.status = status
    pending.delete(id)
    save()
  }
  // A process interrupted mid-dump is evidence of an incomplete run, not success.
  for (const bot of Object.values(state.bots)) {
    for (const dump of bot.dumps || []) if (dump.status === 'running') dump.status = 'interrupted'
  }
  return {
    record, startDump, captureDumpLine, finishDump,
    get (id) { return { bot: id, ...(state.bots[id] || { connections: [], deaths: [], dumps: [] }), caveat: 'Observed events only; correlations do not establish a ban cause. History starts when evidence collection is installed.' } }
  }
}

module.exports = { createEvidenceStore }
