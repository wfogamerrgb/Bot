'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { commandSuggestions } = require('../bot-controls')
function fixture() {
  const widgets = [], commands = []
  function widget(options) {
    const item = { options, hidden: options.hidden, value: '', keys: {}, events: {}, content: '', focus() { this.focused = true }, append() {}, key(names, fn) { for (const name of [].concat(names)) this.keys[name] = fn }, on(name, fn) { this.events[name] = fn }, render() {}, getValue() { return this.value }, setValue(value) { this.value = value }, setContent(value) { this.content = value }, setLabel() {}, show() { this.hidden = false }, hide() { this.hidden = true }, log() {}, scrollTo() {}, getScrollHeight() { return 0 } }
    widgets.push(item); return item
  }
  const bots = Object.fromEntries(Array.from({ length: 100 }, (_, n) => ['Bot' + n, { online: true, logs: [] }]))
  const source = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8')
  const slice = source.slice(source.indexOf('function startTUI()'), source.indexOf('// ── Web GUI: login page'))
  const context = { TUI_GUI: true, require: name => { assert.equal(name, 'neo-blessed'); return { screen: widget, box: widget, log: widget, textbox: widget } }, fs, bots, activeId: 'Bot0', LOG_VIEW_LINES: 400, SYSTEM_ID: '__system__', PROXY_GROUPS_ENABLED: false, PROXY_ENABLED: false, webHandle: null, commandHistory: [], commandSuggestions, commandTableFor: () => ({ '/warp': 'Server command', '/walk': 'Local command' }), escBlessed: text => text, botOnline: entry => entry.online, setImmediate: fn => fn(), subscribeLog() {}, handleCommand: command => commands.push(command), recordHistory() {}, process: { exit() { throw Error('Must use guarded exit') } } }
  const tui = vm.runInNewContext(slice + '; startTUI()', context)
  return { tui, widgets, commands }
}
test('TUI keyboard uses compact fleet counts, bounded scrollback, real Tab cycling, F2 discovery and guarded Ctrl-C', () => {
  const { tui, widgets, commands } = fixture()
  const header = widgets[1]
  assert.match(header.content, /Online 100\/100/)
  assert.doesNotMatch(header.content, /Bot99/)
  assert.equal(tui.logBox.options.scrollback, 400)
  tui.inputBox.value = '/w'
  tui.inputBox.keys.tab()
  assert.equal(tui.inputBox.value, '/warp ')
  tui.inputBox.keys.tab()
  assert.equal(tui.inputBox.value, '/walk ')
  tui.screen.keys.f2()
  tui.screen.keys['C-c']()
  assert.deepEqual(commands, ['/server-commands', '/exit'])
})
