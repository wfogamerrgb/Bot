# ⛔ DO NOT KILL or RUN /exit

**DO NOT RUN `/exit`. DO NOT RUN `/all /dc`. DO NOT `kill` the `node bot.js`
process.**

Everything lives in that one process: every bot account, every running routine
(crates, dumps, shardshop, AFK warps), the web dashboard, cron jobs, the
analytics server. Killing it — or running `/exit` — ends the whole session for
everyone at once.

## The commands that end everything

| Command | What it does | Guard |
| --- | --- | --- |
| `/exit` | Disconnects **every** bot and terminates the process | ⚠️ warns first — repeat once to confirm |
| `/all /dc` | Disconnects **every** bot at once | ⚠️ warns first — repeat once to confirm |
| `/all-slow /dc` | Same as `/all /dc`, staggered | ⚠️ warns first — repeat once to confirm |
| `kill` / Ctrl-C on the process | Nothing can intercept this — **just don't** | none |

## The confirmation rule

The first time one of the guarded commands runs, it prints **only** this and
does nothing else:

> ⚠ WARNING! DO NOT RUN /exit — it kills the bot process and disconnects every
> bot. Repeat the command 1 more time if you want to (within 60s). WARNING!

To actually run it, send the **exact same command** again within 60 seconds.
Anything else — a different command, a typo, or the same command after the
window expires — warns again instead of running. A confirmation is one-shot:
run the command a third time and you get warned again.

## What to use instead

| Goal | Use this |
| --- | --- |
| Disconnect ONE bot | `/dc` (never guarded — it touches one bot only) |
| Stop a hidden dump | `/dump cancel` |
| Stop one `/all-slow` broadcast | `/all-slow-cancel [id]` |
| Stop queued repeats | `/repeat stop` |
| Reconnect one bot | `/reconnect` |
| Reconnect everyone, slowly | `/reconnect-all-slow` |

If you really do mean to end the session: run `/exit`, see the warning, run
`/exit` again. That second one is the one that does it.

---

If you see the warning, **stop** — you were one keystroke away from ending the
session for everyone.
