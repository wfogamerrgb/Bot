'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const dotenv = require('dotenv')
const { generateNames, persistRegeneratedName } = require('../generated-bots')
const { classifyNameTaken } = require('../bot-controls')

test('generated names read like themed handles, not roster serials', () => {
  const names = generateNames(100, [])
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, 100)
  assert.ok(names.every(name => /^[A-Za-z0-9_]{3,16}$/.test(name)))
  // The old shape always ended in a 4-digit serial (AmberBadger0000).
  assert.ok(names.every(name => !/\d{4}$/.test(name)), names.filter(name => /\d{4}$/.test(name)).join(','))
  // The theme has to actually show up: separators and leet digits in the mix.
  assert.ok(names.some(name => name.includes('_')))
  assert.ok(names.some(name => /\d/.test(name)))
  // Underscore is the only special character Minecraft allows.
  assert.ok(names.every(name => !/[^A-Za-z0-9_]/.test(name)))
})

test('a taken name is swapped in place across roster and proxy group', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-bots-'))
  try {
    const file = path.join(dir, '.env'), env = {}
    fs.writeFileSync(file, 'BOT_NAMES=OldName,Other\nPROXY_GROUP_2_HOST=p2\nPROXY_GROUP_2_BOTS=OldName,Other\n')
    const result = persistRegeneratedName({ file, env, taken: 'OldName', existing: ['Other'] })
    const saved = dotenv.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(result.taken, 'OldName')
    assert.equal(result.group, 2)
    assert.equal(result.direct, false)
    assert.ok(/^[A-Za-z0-9_]{3,16}$/.test(result.name))
    assert.notEqual(result.name.toLowerCase(), 'oldname')
    for (const key of ['BOT_NAMES', 'PROXY_GROUP_2_BOTS']) {
      const members = saved[key].split(',')
      assert.equal(members.length, 2)
      assert.ok(!members.some(name => name.toLowerCase() === 'oldname'))
      assert.ok(members.includes(result.name))
      assert.ok(members.includes('Other'))
    }
    assert.equal(env.BOT_NAMES, saved.BOT_NAMES)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a direct-routed taken name moves its BOT_DIRECT flag to the replacement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-bots-'))
  try {
    const file = path.join(dir, '.env'), env = {}
    fs.writeFileSync(file, 'BOT_NAMES=OldName\nBOT_DIRECT_OldName=true\n')
    const result = persistRegeneratedName({ file, env, taken: 'oldname' })
    const saved = dotenv.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(result.direct, true)
    assert.equal(result.group, null)
    assert.equal(saved['BOT_DIRECT_' + result.name], 'true')
    assert.equal(saved.BOT_DIRECT_OldName, undefined)
    assert.equal(env['BOT_DIRECT_' + result.name], 'true')
    assert.equal(env.BOT_DIRECT_OldName, undefined)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('classifyNameTaken matches taken-name reports but not auth verdicts', () => {
  for (const message of [
    'This username is already taken',
    'Account already taken',
    'That name is claimed by another player',
    'This name is already registered',
    'Username is unavailable',
    'Sorry, this name is not available',
    'This name is taken by a premium account'
  ]) {
    assert.ok(classifyNameTaken(message), message)
  }
  for (const message of [
    'already registered', // bare — the account's own registration state
    'already logged in',
    'Wrong password',
    'Too many failed attempts, please try again later',
    'You have been banned for 3 days',
    'Welcome to the server!'
  ]) {
    assert.equal(classifyNameTaken(message), null, message)
  }
})
