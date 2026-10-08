// Serves the vendored xterm.js terminal-emulator assets (see vendor/xterm/).
// The dashboard's TERMINAL panel needs a real VT100/xterm emulator to render
// full-screen TUIs (tmux, the blessed bot TUI); the old stripped <pre> box
// could never do that. Files are read once and cached in memory like chart.js.
const fs = require('fs');
const path = require('path');

// pathname -> [file under vendor/xterm, content-type]
const ASSETS = {
  '/xterm.js': ['xterm.min.js', 'application/javascript; charset=utf-8'],
  '/xterm-addon-fit.js': ['addon-fit.min.js', 'application/javascript; charset=utf-8'],
  '/xterm.css': ['xterm.css', 'text/css; charset=utf-8']
};

const cache = new Map();

function loadAsset(name) {
  if (cache.has(name)) return cache.get(name);
  let buf = Buffer.alloc(0);
  try {
    buf = fs.readFileSync(path.join(__dirname, 'vendor', 'xterm', name));
  } catch (err) {
    console.error('[xterm-static] failed to load ' + name + ':', err.message);
  }
  cache.set(name, buf);
  return buf;
}

function handleXtermAsset(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const entry = ASSETS[pathname];
  if (!entry) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'public, max-age=86400' });
  res.end(loadAsset(entry[0]));
}

module.exports = { handleXtermAsset, ASSETS };
