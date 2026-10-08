'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const assert = require('node:assert/strict')
const settings = require('../settings')

function isolatedSettings(env = {}) {
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'settings.js'), 'utf8'), { require, module, process: { env }, __dirname, setInterval, clearInterval })
  return module.exports
}
test('file reload supersedes changed overrides only and reset returns latest file values', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-env-'))
  const file = path.join(directory, '.env')
  const env = { HOST_SETTING: 'leave-alone' }
  const s = isolatedSettings(env)
  s.define('DELAY_MS', { type: 'ms', def: 1 }); s.define('UNCHANGED', { type: 'string', def: 'default' })
  fs.writeFileSync(file, 'DELAY_MS=1000\nUNCHANGED=old\nREMOVED=value\n')
  try {
    assert.equal(s.watch(file).ok, true)
    s.set('DELAY_MS', '5s'); s.set('UNCHANGED', 'temporary')
    assert.equal(env.DELAY_MS, '5000')
    fs.writeFileSync(file, 'DELAY_MS=2000\nUNCHANGED=old\n')
    assert.equal(s.reload().ok, true)
    assert.equal(s.get('DELAY_MS'), 2000)
    assert.equal(s.source('DELAY_MS'), 'env')
    assert.equal(s.get('UNCHANGED'), 'temporary')
    assert.equal(env.REMOVED, undefined)
    assert.equal(env.HOST_SETTING, 'leave-alone')
    s.set('DELAY_MS', '3s'); s.reset('DELAY_MS')
    assert.equal(s.get('DELAY_MS'), 2000)
    fs.unlinkSync(file)
    assert.equal(s.reload().ok, false)
    assert.equal(s.get('DELAY_MS'), 2000, 'transient deletion must not erase effective settings')
  } finally { s.stopWatching(); fs.rmSync(directory, { recursive: true, force: true }) }
})
test('watcher follows atomic replacement of .env and updates running values', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-env-'))
  const file = path.join(directory, '.env')
  const s = isolatedSettings({})
  fs.writeFileSync(file, 'WATCH_TEST=first\n')
  try {
    s.watch(file)
    const observed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('watcher did not observe replacement')), 5000)
      s.onChange(() => { if (s.get('WATCH_TEST') === 'second') { clearTimeout(timer); resolve() } })
    })
    fs.writeFileSync(file + '.tmp', 'WATCH_TEST=second\n'); fs.renameSync(file + '.tmp', file)
    await observed
    assert.equal(s.get('WATCH_TEST'), 'second')
  } finally { s.stopWatching(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('proxy _PASS and usernames are credentials even without PASSWORD in the key', () => {
  const s = isolatedSettings({ PROXY_PASS: 'hidden-pass', PROXY_USER: 'hidden-user', PROXY_GROUP_7_PASS: 'hidden-group' })
  for (const key of ['PROXY_PASS', 'PROXY_USER', 'PROXY_GROUP_7_PASS', 'PROXY_GROUP_7_USER']) assert.equal(s.isSecret(key), true)
  assert.doesNotMatch(JSON.stringify(s.list()), /hidden-pass|hidden-user|hidden-group/)
})
test('a registered setting falls back to its default, then to the environment, then to the override', () => {
  settings.define('TEST_SETTING_MS', { type: 'ms', def: 15000, group: 'Test', desc: 'a delay' })
  assert.equal(settings.get('TEST_SETTING_MS'), 15000)
  assert.equal(settings.source('TEST_SETTING_MS'), 'default')

  process.env.TEST_SETTING_MS = '30s'
  assert.equal(settings.get('TEST_SETTING_MS'), 30000)
  assert.equal(settings.source('TEST_SETTING_MS'), 'env')

  settings.set('TEST_SETTING_MS', '2m')
  assert.equal(settings.get('TEST_SETTING_MS'), 120000)
  assert.equal(settings.source('TEST_SETTING_MS'), 'override')

  settings.reset('TEST_SETTING_MS')
  assert.equal(settings.get('TEST_SETTING_MS'), 30000)
  delete process.env.TEST_SETTING_MS
})

test('a mistyped case lands on the registered key instead of an inert shadow', () => {
  settings.define('TEST_CASE_SETTING', { type: 'int', def: 1, group: 'Test' })
  const result = settings.set('test_case_setting', '7')
  assert.equal(result.ok, true)
  assert.equal(result.key, 'TEST_CASE_SETTING', 'the canonical name wins')
  assert.equal(settings.get('TEST_CASE_SETTING'), 7)
  assert.equal(settings.get('TeSt_CaSe_SeTtInG'), 7)
  assert.equal(settings.reset('test_case_setting').ok, true)
  assert.equal(settings.get('TEST_CASE_SETTING'), 1)
})

test('a wrong name is recognizable as wrong and suggests the real one', () => {
  settings.define('SOME_LONG_SETTING_NAME', { type: 'string', def: 'x', group: 'Test' })
  assert.equal(settings.isKnownKey('SOME_LONG_SETTING_NAME'), true)
  assert.equal(settings.isKnownKey('some_long_setting_name'), true, 'case-insensitive')
  assert.equal(settings.isKnownKey('SOME_LONG_SETTING_NAM'), false)
  const suggestions = settings.suggestKeys('SOME_LONG_SETTING_NAM')
  assert.equal(suggestions[0], 'SOME_LONG_SETTING_NAME', 'the closest real key is offered')
  // An existing environment key counts as known — it is settable on purpose.
  process.env.TEST_ENV_ONLY_KEY = '1'
  try {
    assert.equal(settings.isKnownKey('TEST_ENV_ONLY_KEY'), true)
  } finally {
    delete process.env.TEST_ENV_ONLY_KEY
  }
})

test('durations parse with units and plain integers are still integers', () => {
  assert.equal(settings.coerce('ms', '1500ms'), 1500)
  assert.equal(settings.coerce('ms', '90s'), 90000)
  assert.equal(settings.coerce('ms', '2h'), 7200000)
  assert.equal(settings.coerce('ms', '3600000'), 3600000)
  assert.equal(settings.coerce('int', '42'), 42)
  assert.equal(settings.coerce('int', '4.5'), null)
  assert.equal(settings.coerce('bool', 'yes'), true)
  assert.equal(settings.coerce('bool', 'false'), false)
  assert.equal(settings.coerce('bool', 'maybe'), null)
  assert.deepEqual(settings.coerce('list', 'A, B ,C'), ['A', 'B', 'C'])
})

test('an unreadable value is refused instead of quietly becoming the default', () => {
  settings.define('TEST_INT_SETTING', { type: 'int', def: 5, group: 'Test', min: 1, max: 10 })
  const bad = settings.set('TEST_INT_SETTING', 'ten')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /not a valid int/)
  assert.equal(settings.get('TEST_INT_SETTING'), 5)

  const tooBig = settings.set('TEST_INT_SETTING', '99')
  assert.equal(tooBig.ok, false)
  assert.match(tooBig.error, /at most 10/)

  const good = settings.set('TEST_INT_SETTING', '7')
  assert.equal(good.ok, true)
  assert.equal(good.value, 7)
  settings.resetAll()
})

test('an override is applied to the process environment in memory and never written to a file', () => {
  settings.define('TEST_OVERRIDE_ONLY', { type: 'int', def: 1, group: 'Test' })
  settings.set('TEST_OVERRIDE_ONLY', '12')
  assert.equal(process.env.TEST_OVERRIDE_ONLY, '12')
  assert.equal(settings.get('TEST_OVERRIDE_ONLY'), 12)
  // Resetting puts the environment back exactly as it was — including unsetting
  // a key that was never there, so nothing leaks into the next command.
  settings.reset('TEST_OVERRIDE_ONLY')
  assert.equal(process.env.TEST_OVERRIDE_ONLY, undefined)
  assert.equal(settings.overrideCount(), 0)
})

test('reset after an override returns the environment value, not the default', () => {
  process.env.TEST_RESET_BACK = 'env-value'
  settings.define('TEST_RESET_BACK', { type: 'string', def: 'def-value', group: 'Test' })
  assert.equal(settings.get('TEST_RESET_BACK'), 'env-value')
  settings.set('TEST_RESET_BACK', 'override-value')
  assert.equal(settings.get('TEST_RESET_BACK'), 'override-value')
  settings.reset('TEST_RESET_BACK')
  assert.equal(settings.get('TEST_RESET_BACK'), 'env-value')
  delete process.env.TEST_RESET_BACK
})

test('a secret is settable, reported as configured, and never echoed back', () => {
  settings.define('TEST_WEBHOOK_SECRET', { type: 'string', def: '', group: 'Test' })
  const result = settings.set('TEST_WEBHOOK_SECRET', 'hunter2')
  assert.equal(result.ok, true)
  assert.equal(result.secret, true)
  assert.equal(result.value, null)
  const row = settings.list().find(r => r.key === 'TEST_WEBHOOK_SECRET')
  assert.equal(row.secret, true)
  assert.equal(row.value, null)
  assert.equal(row.configured, true)
  // The value is in the process environment (the app needs to use it) but is
  // never rendered back out.
  assert.equal(process.env.TEST_WEBHOOK_SECRET, 'hunter2')
  settings.reset('TEST_WEBHOOK_SECRET')
})

test('the list covers registered settings plus real .env keys, and hides host plumbing', () => {
  settings.define('TEST_LISTED', { type: 'string', def: 'x', group: 'Test', desc: 'listed' })
  process.env.TEST_UNREGISTERED_KEY = 'value'
  const rows = settings.list()
  const listed = rows.find(r => r.key === 'TEST_LISTED')
  assert.equal(listed.group, 'Test')
  assert.equal(listed.live, true)
  const unknown = rows.find(r => r.key === 'TEST_UNREGISTERED_KEY')
  assert.equal(unknown.live, false)
  assert.equal(unknown.configured, true)
  // PATH is the container's, not the project's, and would bury the real ones.
  assert.equal(rows.some(r => r.key === 'PATH'), false)
  assert.equal(settings.grouped().some(g => g.group === 'Test'), true)
  delete process.env.TEST_UNREGISTERED_KEY
})

test('an unset registered setting reports its default and says so', () => {
  settings.define('TEST_DEFAULTED', { type: 'int', def: 60, group: 'Test' })
  const row = settings.list().find(r => r.key === 'TEST_DEFAULTED')
  assert.equal(row.value, 60)
  assert.equal(row.source, 'default')
  assert.equal(row.configured, false)
})

test('a key that was never registered can still be set, and is marked not live', () => {
  const result = settings.set('SOMETHING_I_INVENTED', 'ok')
  assert.equal(result.ok, true)
  assert.equal(result.live, false)
  assert.equal(settings.get('SOMETHING_I_INVENTED'), 'ok')
  settings.reset('SOMETHING_I_INVENTED')
})
