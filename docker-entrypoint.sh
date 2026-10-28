#!/bin/sh
# Starts Tor, waits for the SOCKS port, then execs the Node app.
#
# Env precedence (highest wins):
#   1. .env.dockerN  (injected by docker --env-file before this runs)
#   2. defaults set below (only for variables that are UNSET — the "${VAR-default}"
#      form — so an explicitly EMPTY value like PROXY_HOST= stays empty = direct mode)
#   3. built-in defaults in the app code

export PROXY_HOST="${PROXY_HOST-127.0.0.1}"
export PROXY_PORT="${PROXY_PORT-9050}"
export PROXY_TYPE="${PROXY_TYPE-socks5}"
export PROXY_RESTART_CMD="${PROXY_RESTART_CMD-/usr/local/bin/restart-tor}"

# Manual interact 3D viewer: first free port from here, up to 10 attempts
# (prismarine-viewer; served from the same node process, bound to WEB_BIND).
export MANUAL_VIEWER_PORT="${MANUAL_VIEWER_PORT-3000}"

# Web terminal (ttyd) on TTYD_PORT (default 8000) — a browser shell into the
# container, started FIRST via the same orphan trick as tor below (tini reaps
# it). When Tor is the thing that is broken, the terminal is exactly what you
# need to get in and look, so it must not wait behind the Tor bootstrap.
# -W makes it writable (ttyd 1.7.x is read-only by default).
# HTTP basic auth is ALWAYS on: username afk / password raidraid.moc unless
# TTYD_CREDENTIALS overrides it. TTYD_ENABLED=0 disables the terminal entirely.
if [ "${TTYD_ENABLED-1}" != "0" ] && command -v ttyd >/dev/null 2>&1; then
  TTYD_PORT="${TTYD_PORT-8000}"
  TTYD_CREDENTIALS="${TTYD_CREDENTIALS:-afk:raidraid.moc}"
  ( ttyd -p "$TTYD_PORT" -i 0.0.0.0 -W -c "$TTYD_CREDENTIALS" "${TTYD_SHELL:-/bin/bash}" & )
  echo "[entrypoint] ttyd web terminal on 0.0.0.0:${TTYD_PORT} (basic auth: ${TTYD_CREDENTIALS%%:*}:***)"
fi

is_local_host() {
  [ "$1" = "127.0.0.1" ] || [ "$1" = "localhost" ] || [ "$1" = "::1" ]
}
is_local_proxy() {
  is_local_host "$PROXY_HOST"
}

# Any configured route pointing at loopback needs the local Tor — including
# PROXY_GROUP_<N>_HOST routes when PROXY_HOST is empty. The deployed ECS config
# is exactly that (direct default + groups on localhost:9050); the old
# PROXY_HOST-only check skipped Tor there and every group bot got
# "ECONNREFUSED … nothing is listening".
NEED_LOCAL_TOR=0
[ -n "$PROXY_HOST" ] && is_local_host "$PROXY_HOST" && NEED_LOCAL_TOR=1
for group_host in $(env | sed -n 's/^PROXY_GROUP_[0-9][0-9]*_HOST=//p'); do
  [ -n "$group_host" ] && is_local_host "$group_host" && NEED_LOCAL_TOR=1
done

if [ "$NEED_LOCAL_TOR" = "1" ]; then
  # keep tor's SocksPort + ControlPort in sync with PROXY_PORT if it was overridden
  sed -i "s/^SocksPort .*/SocksPort 127.0.0.1:${PROXY_PORT}/" /etc/tor/torrc
  sed -i "s/^ControlPort .*/ControlPort 127.0.0.1:$((PROXY_PORT + 1))/" /etc/tor/torrc
  echo "[entrypoint] starting Tor (SOCKS5 ${PROXY_HOST}:${PROXY_PORT})…"
  # Spawned from a subshell that exits immediately: tor is orphaned and
  # reparents to tini (PID 1), so it is reaped even after restart-tor kills it.
  # A plain `tor &` here makes node its parent once this shell execs, and node
  # never wait()s on children it did not spawn — every restart left a <defunct>.
  ( tor -f /etc/tor/torrc & )

  # Wait until the SOCKS port accepts connections (up to 90 s) so the first
  # bot connection doesn't race the proxy bootstrap.
  i=0
  until node -e "const net=require('net'),s=net.connect(process.env.PROXY_PORT,'127.0.0.1',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 90 ]; then
      echo "[entrypoint] WARNING: Tor not accepting connections after 90s — starting the app anyway; its reconnect logic will retry."
      break
    fi
    sleep 1
  done
  [ "$i" -lt 90 ] && echo "[entrypoint] Tor is up."

  # A bound SOCKS port is NOT a working tunnel: Tor accepts connections long
  # before it has bootstrapped. Starting the bots during bootstrap makes their
  # connects hang, the stall watchdog fires, and restart-tor kills Tor mid-work
  # — the source of "connect ECONNREFUSED 127.0.0.1:9050" in the bot logs.
  # Wait for bootstrap 100% via the control port (SOCKS port + 1, no cookie
  # auth — same convention as scripts/restart-tor.sh).
  if [ "$i" -lt 90 ]; then
    echo "[entrypoint] waiting for Tor to bootstrap (up to 90 s)…"
    CTRL=$((PROXY_PORT + 1))
    j=0
    until CTRL_PORT="$CTRL" node -e '
      const net = require("net");
      const s = net.connect(process.env.CTRL_PORT, "127.0.0.1", () => s.write("AUTHENTICATE\r\n"));
      let buf = "", authed = false;
      s.on("data", d => {
        buf += d;
        if (!authed && /250 OK/.test(buf)) { authed = true; buf = ""; s.write("GETINFO status/bootstrap-phase\r\n"); return; }
        if (authed && /250 OK/.test(buf)) process.exit(/PROGRESS=100/.test(buf) ? 0 : 1);
        if (/5\d\d /.test(buf)) process.exit(1);
      });
      s.on("error", () => process.exit(1));
      setTimeout(() => process.exit(1), 4000);
    ' 2>/dev/null; do
      j=$((j + 1))
      if [ "$j" -ge 90 ]; then
        echo "[entrypoint] WARNING: Tor not bootstrapped after 90s — starting the app anyway; check outbound network restrictions."
        break
      fi
      sleep 1
    done
    [ "$j" -lt 90 ] && echo "[entrypoint] Tor bootstrapped — tunnels are live."
  fi
else
  echo "[entrypoint] PROXY_HOST='${PROXY_HOST}' — not starting local Tor (direct or remote proxy mode)."
fi

echo "[entrypoint] starting app — manual 3D viewer will bind ${WEB_BIND:-0.0.0.0}:${MANUAL_VIEWER_PORT}+ when /manual-interact is used (map host ports to reach it)"
exec node index.js
