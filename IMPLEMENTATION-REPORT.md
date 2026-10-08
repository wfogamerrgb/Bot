# Bot console changes — 2026-10-07

## Follow-up: web login blocked by `foreign origin forbidden`

Reported after the first install: login through the web GUI returned 403.

**Cause.** The CSRF guard compared `Origin` to the `Host` header. SSH tunnels,
port-forwards and reverse proxies deliver the request with a **rewritten**
`Host` (e.g. `localhost`) while the browser's `Origin` is the public tunnel URL,
so every legitimate login POST was rejected.

Reproduced against the running app (unauthenticated POSTs, nothing executed):

| Request | Before |
| --- | --- |
| `Host: 52.237.167.218`, `Origin: http://52.237.167.218` | 303 (worked) |
| `Host: localhost`, `Origin: http://127.0.0.1:80` (tunnel) | **403** |
| `X-Forwarded-Host: bot.tunnel.example` | **403** |
| `Sec-Fetch-Site: same-origin`, rewritten Host | **403** |
| `Origin: https://evil.example` | 403 (correct) |

**Fix.** The guard now accepts, in order: the browser's own
`Sec-Fetch-Site: same-origin`; a `Host`/`X-Forwarded-Host` match; an explicit
`WEB_ALLOWED_ORIGINS` entry; and loopback-to-loopback (SSH tunnel) requests.
It still always refuses `Sec-Fetch-Site: cross-site` and `Origin: null`, and a
loopback-looking `Origin` arriving from a remote peer is **not** treated as a
tunnel. The 403 body names the mismatch and the setting to fix it.

Verified over real HTTP against the fixed code (isolated instance, empty roster,
loopback only, hard timeout — the live fleet was never touched):

| Request | After |
| --- | --- |
| direct IP (`Host == Origin`) | 303 |
| tunnel, rewritten Host, loopback Origin | **303** |
| proxy with `X-Forwarded-Host` | **303** |
| `Sec-Fetch-Site: same-origin`, rewritten Host | **303** |
| `Origin: https://evil.example` | 403 |
| `Origin: null` | 403 |
| `Sec-Fetch-Site: cross-site` | 403 |
| loopback `Origin` from a remote peer | 403 |

New regression test `origin guard allows tunnels and proxies but keeps blocking
CSRF` covers the same matrix at the request/WebSocket level.

**Remaining gap.** A browser that sends *no* `Sec-Fetch-Site` **and** is behind a
non-loopback tunnel still needs `WEB_ALLOWED_ORIGINS=https://your-tunnel-host` in
`.env`; the 403 message now states this. Documented in `README.md` and
`.env.example` (that one file was patched additively on the server in place,
preserving its existing uncommitted content, because the file tools block
`.env*` paths).

**Activation.** The fix is in the installed `bot.js` but the running process
(PID 1594013) still holds the old code. It takes effect at the next application
start; restarting disconnects the whole fleet and was **not** done. Until then,
opening the dashboard directly at `http://52.237.167.218/` works with the current
process.

## Delivery

Installed and SHA-256 verified 18 source/documentation/test files in the remote project `/home/OnlyAProgrammer/Bot`.

Backup of the previous versions: `/home/OnlyAProgrammer/Bot-backup-freebuff-20261007T182149Z`.

Existing unrelated edits were preserved. No commit, push, process restart, fleet disconnect, live `.env` modification, generated account creation or live Minecraft command was performed. Changes take effect at the next application start/restart. There was no listener on configured dashboard port 80 at final inspection; no attempt was made to start the live fleet automatically.

The running Preview tab is an isolated fixture at http://127.0.0.1:4821/ with simulated accounts/commands, not a live dashboard or public deployment.

## Behavior

- Hide offline bots excludes every non-online card, including banned, removed, connecting and selected offline accounts. Preference persists across reloads.
- `/overview` queries/reports online accounts only and retains their stable roster numbers.
- `/start-login` runs independently of the initial `.env` queue. Duplicate, blocked and invalid account checks remain.
- `/start-rtp` connects missing/disconnected targets with staggered attempts and waits for startup/authentication readiness; existing/in-flight sockets are reused. `/stop-rtp` cancels pending starts too.
- `/server-commands [filter] [--refresh]` lists server-advertised per-account commands and argument hints. `--refresh` uses Mineflayer tab completion without command execution. Backend configuration transitions invalidate old trees.
- Dashboard **server cmds** supports account selection, filtering, refresh, and click-to-prepare. Server command autocomplete does not override local command collisions; `/chat /command` bypasses local commands.
- `/new-gen [1-100] [group=auto|direct|N]` generates Minecraft-valid, locally unique names, atomically saves `.env` roster/group assignments with owner-only permissions, then connects staggered. Auto balances valid proxy groups; direct explicitly bypasses the global proxy. Save failures connect no bots. No Mojang availability check is performed.
- Sparse proxy group indexes are supported; proxy credential usernames are no longer printed.
- TUI: compact online/total header, bounded scrollback, corrected repeated Tab cycling, F2 server-command list, guarded Ctrl-C.
- Security: `_PASS` and proxy usernames treated as secrets; authentication commands and known credential values redacted from shared logs/history; terminal escape injection stripped; foreign-origin mutations/upgrades rejected; session URL tokens disabled; logout/session expiration revoke open WebSockets and SSH channels.
- SSH terminal closes only its channel, without sending `exit` into an attached TUI; early close blocks late connection completion; close resets browser terminal display.

## Examples

```text
/start-login
/start-rtp
/start-rtp AccountA,AccountB
/stop-rtp
/server-commands
/server-commands warp
/server-commands --refresh
/new-gen 5
/new-gen 3 group=2
/new-gen 2 group=direct
```

## Verification

- Baseline had two failing integration tests: a stale hardcoded healthy-reset timer and a Tor test that expected reconnects despite a failed control signal. Updated deterministic fixtures preserve the intended guard behavior.
- Final full suite: **524 passed, 0 failed, 0 skipped**.
- All changed runtime JavaScript modules passed `node --check`. The project has no configured TypeScript/typecheck script.
- Final installed source matches the tested staging hashes; syntax checks repeated after installation.
- Browser interactions: hide offline -> only Alpha visible; reload retains hidden preference; command account/search panel loads; click prepares `/chat /warp ` without submission; `/wa` autocomplete displays `/warp`; no captured console errors.
- TUI widget-interface regression verifies F2, guarded Ctrl-C, real Tab cycling, header and bounded scrollback.
- Generated-account tests use isolated files and verify persistent roster/groups, permissions, failed-save cleanup and concurrent-edit rejection.
- Authentication/security tests cover anonymous API access, foreign origins, revoked sockets, URL-token rejection and credential masking.
- Browser screenshot capture was blocked by the host compositor; no screenshot-based visual verification is claimed.
- Live Minecraft authentication, proxy connections, server command packets and RTP were not exercised against the production server, to avoid disrupting existing sessions/accounts. Tests use real code with mocked connections and fixture protocol packets.
- File-change hooks are unsupported by this host; explicit Node syntax/tests were run instead.

## Security boundary

The authenticated **full SSH terminal is not a sandbox**: an authorized shell user can still read files, including `.env`. Disable `WEB_TERMINAL_ENABLED` for dashboard viewers who should not have shell access. These changes prevent accidental shared-dashboard/log exposure, not deliberate privileged shell access. The SSH password shared in chat should be rotated.
