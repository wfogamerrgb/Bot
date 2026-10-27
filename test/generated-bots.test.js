'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const dotenv = require('dotenv')
const { generateNames, persistGeneratedBots, updateEnvText } = require('../generated-bots')
test('generated Minecraft names are valid, unique and case-insensitively avoid existing names', () => {
  const names = generateNames(100, ['AmberBadger0000'])
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, 100)
  assert.ok(names.every(name => /^[A-Za-z0-9_]{3,16}$/.test(name)))
  assert.equal(names.includes('AmberBadger0000'), false)
  assert.throws(() => generateNames(101), /1 and 100/)
})
test('username-list edits preserve unrelated credentials, comments and line endings', () => {
  const text = '# private\r\nLOGIN_PASSWORD="secret # value"\r\nBOT_NAMES=Old\r\n'
  assert.equal(updateEnvText(text, { BOT_NAMES: 'Old,New' }), '# private\r\nLOGIN_PASSWORD="secret # value"\r\nBOT_NAMES=Old,New\r\n')
})
test('auto routes 3/4 of generated names to direct and 1/4 to a single proxy group', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-bots-'))
  try {
    const file = path.join(dir, '.env'), env = {}
    fs.writeFileSync(file, 'BOT_NAMES=Old\nPROXY_GROUP_2_HOST=p2\n')
    const result = persistGeneratedBots({ file, env, count: 8 })
    const saved = dotenv.parse(fs.readFileSync(file, 'utf8'))
    // The spec: direct is used 2x more — 3/4 of the names when one proxy
    // group exists, the group taking the remaining 1/4.
    assert.equal(result.assignments.filter(a => a.group == null).length, 6)
    assert.equal(result.assignments.filter(a => a.group === 2).length, 2)
    assert.equal(saved.PROXY_GROUP_2_BOTS.split(',').length, 2)
    assert.equal(Object.keys(saved).filter(key => /^BOT_DIRECT_/.test(key)).length, 6)
    // A direct pick is genuinely direct: flagged like group=direct so a
    // global PROXY_HOST cannot sweep it back onto a proxy.
    const directName = result.assignments.find(a => a.group == null).name
    assert.equal(saved['BOT_DIRECT_' + directName], 'true')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('auto weights direct at 3 shares against every proxy group 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-bots-'))
  try {
    const file = path.join(dir, '.env'), env = {}
    fs.writeFileSync(file, 'BOT_NAMES=Old\nPROXY_GROUP_2_HOST=p2\nPROXY_GROUP_7_HOST=p7\n')
    const result = persistGeneratedBots({ file, env, count: 5 })
    // Two groups: direct 3 : group 2 : group 7 — each further proxy divides
    // its own single share rather than halving the direct favourite.
    assert.deepEqual(
      [result.assignments.filter(a => a.group == null).length,
       result.assignments.filter(a => a.group === 2).length,
       result.assignments.filter(a => a.group === 7).length],
      [3, 1, 1])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('generated roster survives reload with weighted sparse proxy groups and restricted env permissions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-bots-'))
  try {
    const file = path.join(dir, '.env'), env = {}
    fs.writeFileSync(file, '# credentials stay unchanged\nBOT_NAMES=Old\nLOGIN_PASSWORD="keep # me"\nPROXY_GROUP_2_HOST=p2\nPROXY_GROUP_2_BOTS=Old\nPROXY_GROUP_7_HOST=p7\n')
    const result = persistGeneratedBots({ file, env, count: 6 })
    const saved = dotenv.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(saved.BOT_NAMES.split(',').length, 7)
    assert.equal(saved.LOGIN_PASSWORD, 'keep # me')
    // Weighted split for 6 names over direct/g2/g7 (Old already in g2):
    // 4 direct, 1 into group 2, 1 into group 7 — groups stay balanced with
    // each other while direct takes its 3-share favourite slot.
    assert.equal(result.assignments.filter(a => a.group == null).length, 4)
    assert.equal(result.assignments.filter(a => a.group === 2).length, 1)
    assert.equal(result.assignments.filter(a => a.group === 7).length, 1)
    assert.equal(saved.PROXY_GROUP_2_BOTS.split(',').length, 2)
    assert.equal(saved.PROXY_GROUP_7_BOTS.split(',').length, 1)
    assert.equal(Object.keys(saved).filter(key => /^BOT_DIRECT_/.test(key)).length, 4)
    assert.equal(result.assignments.length, 6)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(env.BOT_NAMES, saved.BOT_NAMES)
    assert.ok(result.names.every(name => saved.BOT_NAMES.includes(name)))
    const direct = persistGeneratedBots({ file, env, group: 'direct' })
    assert.equal(dotenv.parse(fs.readFileSync(file, 'utf8'))['BOT_DIRECT_' + direct.names[0]], 'true')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
test('save failures leave environment untouched and do not leave temporary credentials files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-bots-'))
  try {
    const file = path.join(dir, '.env'), env = { BOT_NAMES: 'Old' }
    fs.writeFileSync(file, 'BOT_NAMES=Old\n')
    const io = { ...fs, renameSync() { throw Object.assign(Error('denied'), { code: 'EACCES' }) } }
    assert.throws(() => persistGeneratedBots({ file, env, io }), /denied/)
    assert.equal(env.BOT_NAMES, 'Old')
    assert.deepEqual(fs.readdirSync(dir), ['.env'])
    assert.throws(() => persistGeneratedBots({ file, env, group: '9' }), /valid HOST/)
    let reads = 0
    const concurrent = { ...fs, readFileSync(name, encoding) { if (name === file && ++reads === 2) fs.writeFileSync(file, 'BOT_NAMES=Edited\n'); return fs.readFileSync(name, encoding) } }
    assert.throws(() => persistGeneratedBots({ file, env, io: concurrent }), /changed while generating/)
    assert.equal(fs.readFileSync(file, 'utf8'), 'BOT_NAMES=Edited\n')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
