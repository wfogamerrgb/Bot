'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { EventEmitter } = require('node:events')
function fixture() {
  let lookup, client, shell
  const module = { exports: {} }
  class Client extends EventEmitter {
    constructor() { super(); client = this; this.connects = 0; this.ends = 0 }
    connect() { this.connects++ }
    end() { this.ends++ }
    shell(_opts, cb) { shell = new EventEmitter(); shell.stderr = new EventEmitter(); shell.setEncoding = () => {}; shell.end = (...args) => { shell.endArgs = args }; cb(null, shell) }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'expose-terminal.js'), 'utf8'), { module, process: { env: {} }, require(name) { if (name === 'ssh2') return { Client }; if (name === 'dns') return { lookup(_host, cb) { lookup = cb } }; return require(name) } })
  const terminal = module.exports.createTerminal({ enabled: true, username: 'test', host: 'localhost', skipHostKeyVerification: true })
  return { terminal, get client() { return client }, get shell() { return shell }, lookup: () => lookup(null, '127.0.0.1') }
}
test('closing before DNS completes never opens a late SSH connection', async () => {
  const f = fixture(), connecting = f.terminal.connect()
  f.terminal.close(); f.lookup()
  await assert.rejects(connecting, /closed/)
  assert.equal(f.client.connects, 0)
})
test('closing the web terminal only ends its channel, never sends exit to the bot TUI', async () => {
  const f = fixture(), connecting = f.terminal.connect()
  f.lookup(); f.client.emit('ready'); await connecting
  f.terminal.close()
  assert.deepEqual(f.shell.endArgs, [])
  assert.equal(f.client.ends, 1)
})
