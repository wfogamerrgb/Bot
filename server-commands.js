'use strict'

const validLiteral = name => typeof name === 'string' && /^[A-Za-z0-9_:.+-]{1,128}$/.test(name)
const nodeType = node => typeof node?.flags === 'number' ? node.flags & 3 : node?.flags?.command_node_type
const nodeName = node => node?.extraNodeData?.name ?? node?.name

// Never request /help or execute commands to discover them. The server sends
// the tree visible to this account, and may replace it after a backend transfer.
function decodeCommandTree(packet) {
  const nodes = packet?.nodes
  const rootIndex = packet?.rootIndex ?? 0
  if (!Array.isArray(nodes) || nodes.length > 100000 || !Number.isInteger(rootIndex) || !nodes[rootIndex]) return []
  const roots = nodes[rootIndex].children
  if (!Array.isArray(roots)) return []
  const result = new Map()
  let work = 0
  for (const index of roots.slice(0, 4096)) {
    const root = nodes[index], name = nodeName(root)
    if (nodeType(root) !== 1 || !validLiteral(name)) continue
    const command = '/' + name
    const usages = new Set([command])
    const stack = [{ index, parts: [command], seen: new Set() }]
    while (stack.length && work++ < 20000) {
      const current = stack.pop(), node = nodes[current.index]
      if (!node || current.seen.has(current.index) || current.parts.length >= 16) continue
      const seen = new Set(current.seen).add(current.index)
      for (const childIndex of (node.children || []).slice(0, 128)) {
        const child = nodes[childIndex], childName = nodeName(child), type = nodeType(child)
        if (![1, 2].includes(type) || !validLiteral(childName)) continue
        const parts = [...current.parts, type === 2 ? `<${childName}>` : childName]
        if (usages.size < 64) usages.add(parts.join(' '))
        stack.push({ index: childIndex, parts, seen })
      }
    }
    result.set(command, { command, usages: [...usages] })
  }
  return [...result.values()].sort((a, b) => a.command.localeCompare(b.command))
}

function decodeCompletions(matches) {
  const result = new Map()
  for (const match of (Array.isArray(matches) ? matches : []).slice(0, 4096)) {
    const name = String(typeof match === 'string' ? match : match?.match ?? match?.text ?? '').replace(/^\//, '')
    if (validLiteral(name)) result.set('/' + name, { command: '/' + name, usages: ['/' + name] })
  }
  return [...result.values()].sort((a, b) => a.command.localeCompare(b.command))
}
module.exports = { decodeCommandTree, decodeCompletions }
