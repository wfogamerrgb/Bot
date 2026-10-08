'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { decodeCommandTree, decodeCompletions } = require('../server-commands')
test('decodes actual Minecraft bitfields, root literals and argument usages', () => {
  const nodes = [
    { flags: { command_node_type: 0 }, children: [1, 3, 4] },
    { flags: { command_node_type: 1 }, extraNodeData: { name: 'warp' }, children: [2] },
    { flags: { command_node_type: 2 }, extraNodeData: { name: 'destination', parser: 'brigadier:string' }, children: [] },
    { flags: 1, extraNodeData: { name: 'minecraft:help' }, children: [] },
    { flags: 2, extraNodeData: { name: 'not_a_command' }, children: [] }
  ]
  assert.deepEqual(decodeCommandTree({ nodes, rootIndex: 0 }), [
    { command: '/minecraft:help', usages: ['/minecraft:help'] },
    { command: '/warp', usages: ['/warp', '/warp <destination>'] }
  ])
})
test('cyclic, malformed and huge trees do not escape resource bounds', () => {
  assert.deepEqual(decodeCommandTree({ nodes: new Array(100001) }), [])
  assert.deepEqual(decodeCommandTree({ nodes: [], rootIndex: -1 }), [])
  assert.deepEqual(decodeCommandTree({ nodes: [{ children: [1] }, { flags: 1, name: '<script>', children: [] }] }), [])
  const nodes = [{ children: [1] }, { flags: 1, name: 'loop', children: [1] }]
  const rows = decodeCommandTree({ nodes })
  assert.equal(rows.length, 1)
  assert.ok(rows[0].usages.length <= 64)
})
test('tab completion accepts plugin and namespaced commands but rejects malformed text', () => {
  assert.deepEqual(decodeCompletions([{ match: '/warp' }, '/warp', { match: 'essentials:home' }, { match: '<script>' }]).map(row => row.command), ['/essentials:home', '/warp'])
})
