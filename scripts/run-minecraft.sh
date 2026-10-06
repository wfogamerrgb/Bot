#!/usr/bin/env bash
# ── npm run minecraft — run the Minecraft web client ────────────────────────
# Builds the client first if web-client/dist is missing (one-time; the same
# scripts/build-web-client.sh the Dockerfile and the bot's /play page use), then
# serves it with web-client.js — the same server bot.js starts for the /play
# tab. Open the printed URL (default http://localhost:8090/) to play.
#
# Env: MC_WEB_CLIENT_PORT (8090), MC_WEB_CLIENT_BIND (0.0.0.0),
#      MC_WEB_CLIENT_PORT_MAX_ATTEMPTS (10).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f web-client/dist/index.html ]; then
  echo "▸ no Minecraft web client build found — building it now (one-time, takes a few minutes)…"
  bash ./scripts/build-web-client.sh
fi

exec node web-client.js
