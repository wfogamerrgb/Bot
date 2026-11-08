'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const dotenv = require('dotenv')
const { generateNames, generateAvailableNames, persistGeneratedBotsAvailable, persistRegeneratedName, persistRegeneratedNameAvailable } = require('../generated-bots')
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

// /new-gen asks Mojang before it saves a name. A candidate that resolves to a
// real account is dropped (that name can never join a premium-auth server) and
// the count still has to come out whole.
test('generateAvailableNames skips Mojang-registered candidates', async () => {
  let calls = 0
  const check = async () => { calls++; return calls <= 3 }
  const { names, rejected } = await generateAvailableNames(5, [], { check })
  assert.equal(rejected, 3, 'the first three candidates were reported taken')
  assert.equal(names.length, 5)
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, 5)
  assert.equal(calls, 8, 'three rejected + five accepted candidates checked')
  // Existing roster names are never even checked.
  let checked = 0
  const again = await generateAvailableNames(2, names, { check: async () => { checked++; return false } })
  assert.equal(checked, 2)
  assert.ok(again.names.every(name => !names.some(old => old.toLowerCase() === name.toLowerCase())))
})

test('generateAvailableNames fails loudly instead of returning a taken name', async () => {
  await assert.rejects(
    () => generateAvailableNames(3, [], { check: async () => true, maxAttempts: 20 }),
    /already taken/
  )
})

test('/new-gen saves only unregistered names and routes them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-bots-'))
  try {
    const file = path.join(dir, '.env'), env = {}
    fs.writeFileSync(file, 'BOT_NAMES=OldName\n')
    const result = await persistGeneratedBotsAvailable({ file, env, existing: ['OldName'], count: 2, group: 'direct', check: async () => false })
    const saved = dotenv.parse(fs.readFileSync(file, 'utf8'))
    const members = saved.BOT_NAMES.split(',')
    assert.deepEqual(members.slice(0, 1), ['OldName'], 'the existing roster is preserved')
    assert.equal(members.length, 3)
    assert.equal(result.names.length, 2)
    assert.equal(result.rejected, 0)
    for (const name of result.names) assert.equal(saved['BOT_DIRECT_' + name], 'true', 'direct routing is saved per name')
    assert.equal(env.BOT_NAMES, saved.BOT_NAMES)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
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

// The server's "not logged into your Minecraft account" kick is not a password
// problem: this name will never be admitted. It has to take the same recovery
// as a taken username (retire + regenerate), not a retry loop.
test('a rejected Minecraft session is detected as an unusable account', () => {
  const kick = '{"color":"red","text":"You are not logged into your Minecraft account. If you are logged into your Minecraft account, try restarting your Minecraft client."}'
  const verdict = classifyNameTaken(kick)
  assert.ok(verdict)
  assert.equal(verdict.reason, 'server rejected the account session')
  // ...while an actual credential problem is still not a name problem.
  assert.equal(classifyNameTaken('Wrong password'), null)
  assert.equal(classifyNameTaken('You are already logged in'), null)
})

test('a rejected account is replaced with a Mojang-free name in the same route', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-avail-'))
  try {
    const file = path.join(dir, '.env'), env = {}
    fs.writeFileSync(file, 'BOT_NAMES=OldName,Other\nPROXY_GROUP_2_HOST=p2\nPROXY_GROUP_2_BOTS=OldName,Other\n')
    let calls = 0
    const result = await persistRegeneratedNameAvailable({
      file, env, taken: 'OldName', existing: ['Other'],
      check: async () => { calls++; return calls === 1 }
    })
    assert.equal(calls, 2, 'the first candidate was taken and skipped')
    assert.equal(result.rejected, 1)
    assert.equal(result.group, 2, 'the replacement keeps the proxy group')
    const saved = dotenv.parse(fs.readFileSync(file, 'utf8'))
    for (const key of ['BOT_NAMES', 'PROXY_GROUP_2_BOTS']) {
      const members = saved[key].split(',')
      assert.ok(!members.some(name => name.toLowerCase() === 'oldname'))
      assert.ok(members.includes(result.name))
      assert.ok(members.includes('Other'))
    }
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
