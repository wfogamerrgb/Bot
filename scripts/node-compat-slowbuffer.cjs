// ── Node.js compat shim: restore buffer.SlowBuffer ──────────────────────────
// Node.js removed `buffer.SlowBuffer` (it had been a deprecated alias of
// `Buffer` since v6). Old transitive dependencies still read it at require
// time — e.g. buffer-equal-constant-time@1.0.1 (via jwa) does
//   var origSlowBufEqual = SlowBuffer.prototype.equal;
// which throws "TypeError: Cannot read properties of undefined (reading
// 'prototype')" the moment it loads. That aborted the web-client build on
// Node 25+ ("Command failed: tsx ./scripts/makeOptimizedMcData.mjs").
//
// scripts/build-web-client.sh prepends this file with
// NODE_OPTIONS="--require …" so every Node process the build spawns (pnpm,
// tsx, rsbuild workers) sees the alias before any dependency loads. The
// assignment is a no-op on Node versions that still ship SlowBuffer.
//
// SlowBuffer was always just Buffer after the pre-pooling era, so aliasing it
// to Buffer is behavior-identical for these dependencies (they only call
// .prototype methods that Buffer also has).
'use strict'
const buffer = require('buffer')
if (typeof buffer.SlowBuffer !== 'function') {
  try {
    buffer.SlowBuffer = buffer.Buffer
  } catch (_) {
    // Frozen export object — nothing else we can do; the old dep will fail
    // exactly as it did without this shim.
  }
}
