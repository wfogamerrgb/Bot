#!/bin/sh
# Starts one Tor instance per local SOCKS port, waits for every one of them to
# bootstrap, then execs the Node app.
#
# One Tor is not enough any more: the fleet runs three proxy groups and each
# group has its own port (9050 / 9150 / 9250) so a flagged exit only takes one
# cohort with it. This entrypoint derives that port list from the environment
# itself — PROXY_PORT for the default route plus every PROXY_GROUP_<N>_PORT whose
# PROXY_GROUP_<N>_HOST is loopback — so adding a group to .env is all it takes.
#
# Env precedence (highest wins):
#   1. .env.dockerN / task-definition env (injected before this runs)
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
# HTTP basic auth is ALWAYS on: the credentials below are a PLACEHOLDER — set
# TTYD_CREDENTIALS in the task definition/env for any real deployment, or the
# shell is reachable with a password that is published in this repo.
# TTYD_ENABLED=0 disables the terminal entirely.
if [ "${TTYD_ENABLED-1}" != "0" ] && command -v ttyd >/dev/null 2>&1; then
  TTYD_PORT="${TTYD_PORT-8000}"
  TTYD_CREDENTIALS="${TTYD_CREDENTIALS:-afk:CHANGE_ME}"
  ( ttyd -p "$TTYD_PORT" -i 0.0.0.0 -W -c "$TTYD_CREDENTIALS" "${TTYD_SHELL:-/bin/bash}" & )
  echo "[entrypoint] ttyd web terminal on 0.0.0.0:${TTYD_PORT} (basic auth: ${TTYD_CREDENTIALS%%:*}:***)"
fi

is_local_host() {
  [ "$1" = "127.0.0.1" ] || [ "$1" = "localhost" ] || [ "$1" = "::1" ]
}

# Every loopback SOCKS port this container has to serve. PROXY_HOST may be empty
# (group-only config) — that is exactly the deployed ECS shape, so the port list
# must not depend on it.
TOR_PORTS=""
add_port() {
  case " $TOR_PORTS " in
    *" $1 "*) ;;
    *) TOR_PORTS="$TOR_PORTS $1" ;;
  esac
}
if [ -n "$PROXY_HOST" ] && is_local_host "$PROXY_HOST"; then add_port "$PROXY_PORT"; fi
# Pair each group's HOST with the same group's PORT (a single loop cannot do
# that, so the indices are collected first).
for index in $(env | sed -n 's/^PROXY_GROUP_\([0-9][0-9]*\)_HOST=.*/\1/p' | sort -n); do
  eval "group_host=\${PROXY_GROUP_${index}_HOST:-}"
  eval "group_port=\${PROXY_GROUP_${index}_PORT:-1080}"
  if [ -n "$group_host" ] && is_local_host "$group_host"; then add_port "$group_port"; fi
done
# No loopback route configured at all → keep the historical single Tor on 9050
# (a direct-only deployment needs nothing, but a PROXY_HOST default of
# 127.0.0.1 still has to answer).
[ -z "$TOR_PORTS" ] && add_port "$PROXY_PORT"
TOR_PORTS="${TOR_PORTS# }"
export TOR_PORTS

if [ -n "$TOR_PORTS" ]; then
  echo "[entrypoint] starting Tor instances for SOCKS ports: ${TOR_PORTS}"
  /usr/local/bin/tor-fleet start

  # Wait until every SOCKS port accepts connections (up to 90 s) so the first
  # bot connection doesn't race the proxy bootstrap.
  for port in $TOR_PORTS; do
    i=0
    until PORT="$port" node -e 'const net=require("net"),s=net.connect(process.env.PORT,"127.0.0.1",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),1500)' 2>/dev/null; do
      i=$((i + 1))
      if [ "$i" -ge 90 ]; then
        echo "[entrypoint] WARNING: Tor on :${port} not accepting connections after 90s — starting the app anyway; its reconnect logic will retry."
        break
      fi
      sleep 1
    done
    [ "$i" -lt 90 ] && echo "[entrypoint] Tor on :${port} is up."
  done

  # A bound SOCKS port is NOT a working tunnel: Tor accepts connections long
  # before it has bootstrapped. Starting the bots during bootstrap makes their
  # connects hang, the stall watchdog fires, and restart-tor kills Tor mid-work.
  # Wait for bootstrap 100% on every instance via its control port (SOCKS + 1,
  # no cookie auth — the same convention scripts/restart-tor.sh uses).
  for port in $TOR_PORTS; do
    ctrl=$((port + 1))
    echo "[entrypoint] waiting for Tor on :${port} to bootstrap (control :${ctrl}, up to 90 s)…"
    j=0
    until CTRL_PORT="$ctrl" node -e '
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
        echo "[entrypoint] WARNING: Tor on :${port} not bootstrapped after 90s — starting the app anyway; check outbound network restrictions."
        break
      fi
      sleep 1
    done
    [ "$j" -lt 90 ] && echo "[entrypoint] Tor on :${port} bootstrapped — tunnels are live."
  done
else
  echo "[entrypoint] no loopback proxy route configured — not starting Tor (direct or remote proxy mode)."
fi

echo "[entrypoint] starting app — manual 3D viewer will bind ${WEB_BIND:-0.0.0.0}:${MANUAL_VIEWER_PORT}+ when /manual-interact is used (map host ports to reach it)"
exec node index.js
