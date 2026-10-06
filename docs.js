'use strict'
// ── Built-in documentation ──────────────────────────────────────────────────
// One source of truth for three surfaces: the web-GUI docs panel (/api/docs),
// the TUI `/doc` command, and the command reference (generated from the live
// COMMANDS map so the docs can never drift from the actual command list).
//
// Structure: sections → entries. An entry is { title, desc, examples: [] }.
// Everything here is plain text — renderers decide the styling.

const SECTIONS = [
  {
    id: 'getting-started',
    title: 'Getting started',
    summary: 'What this console is and how to drive it',
    entries: [
      {
        title: 'The console',
        desc: 'This program runs a fleet of Minecraft bots and gives you three ways to command it: the web dashboard (WEB_PORT, login WEB_PASSWORD), the terminal TUI (TUI_GUI), and cron jobs. Commands typed in the web command bar run on the selected bot (or on ALL channels). Type / for command suggestions; /help lists every command; /doc opens these docs.',
        examples: []
      },
      {
        title: 'Command routing',
        desc: 'Most commands act on the ACTIVE bot (the one selected in the sidebar). Fleet commands (/all, /all-slow, /find, /crates-all, /dump hidden) act on many bots at once. Commands starting with / are usually intercepted locally; anything unrecognized is sent to the server as the active bot\'s chat or server command.',
        examples: ['/switch 3', '/all /status', '/all-slow 30 /spawners']
      },
      {
        title: 'Command chains',
        desc: 'Commands can be chained: && waits for each step, ; fires without waiting, and sleep pauses. Escaped \\&& and \\; send literal operators. /repeat re-runs a command n times or for a duration.',
        examples: ['/status && sleep 5s && /dump "fatal"', '/repeat 30s 2s /spawners']
      }
    ]
  },
  {
    id: 'dump',
    title: '/dump — deposit items',
    summary: 'TPA-based dumping with item filters and container filters',
    entries: [
      {
        title: 'Grammar',
        desc: '/dump [mode] ["term" ...] [type ...] [color ...]. Modes: home (uses DUMP_HOME_COMMAND, default /home stash), hidden (the low-profile fleet dump — see its own section), cancel (stop a hidden dump and any pending dump timers). Everything else is optional; with no arguments the whole inventory is deposited into any nearby container and the bot warps back to AFK (WARP_COMMAND, default /warp afk).',
        examples: ['/dump', '/dump home', '/dump cancel']
      },
      {
        title: 'Item filters ("terms")',
        desc: 'Quoted strings filter WHAT gets deposited. Multiple terms are OR\'d; matching is case-insensitive and searches the display name, custom (anvil) name, alt/registry name AND the item\'s NBT/component text — so "netherite" also matches a renamed Fatal Chestplate whose base item or Material tag is netherite. Matching folds _/-/spaces, so "light sword" finds Light_Sword. Items that do not match stay in the inventory and are reported as left behind. A bare word works too (/dump sword ≡ /dump "sword") unless it is a keyword or looks like a typo of one.',
        examples: ['/dump "fatal"', '/dump "fatal" "enchanted"', '/dump "netherite"', '/dump sword']
      },
      {
        title: 'Container filters (type + color)',
        desc: 'The type keyword restricts WHERE items are deposited: shulker (shulker boxes), chest (chest + trapped chest), or all (default = both). Repeatable and OR\'d. A shulker color (white, orange, magenta, light_blue, yellow, lime, pink, gray, light_gray, cyan, purple, blue, brown, green, red, black) restricts shulker boxes to that color and implies the shulker type. Quoting forces a word to be a term: /dump "chest" searches for items called chest, /dump chest restricts to chests.',
        examples: ['/dump shulker', '/dump "fatal" shulker yellow', '/dump "fatal" "enchanted" shulker chest', '/dump "chestplate" chest']
      },
      {
        title: 'Full example walkthrough',
        desc: '/dump "fatal" dumps every item with "fatal" in any of its names (Fatal Chestplate, Fatal Boots, Fatal Sword, …). /dump hidden "fatal" shulker does the same but as a hidden fleet dump into shulker boxes only. /dump hidden "chestplate" chest dumps only chestplate-named items into chests. /dump "fatal" shulker yellow deposits Fatal items into yellow shulker boxes only.',
        examples: ['/dump "fatal"', '/dump hidden "fatal" shulker', '/dump hidden "chestplate" chest', '/dump "fatal" shulker yellow', '/dump "fatal" "enchanted" shulker chest']
      },
      {
        title: 'Reports and safety',
        desc: 'Each dump reports what was deposited, which containers were used, and what stayed behind (with the reason). A dump with a filter that matches nothing does NOT teleport — it reports "no items match" and stops. A chest that will not open is abandoned after DUMP_OPEN_TIMEOUT_MS instead of stalling the run. /dump-spawners is the spawner-only variant of the plain dump.',
        examples: ['/dump-spawners']
      }
    ]
  },
  {
    id: 'dump-hidden',
    title: '/dump hidden — low-profile fleet dump',
    summary: 'At most 4 bots at the spot at a time, /tpa to the main player, /warp afk reset',
    entries: [
      {
        title: 'How it works',
        desc: 'Every bot is put into a shuffled queue. A sliding-window scheduler keeps at most DUMP_HIDDEN_CONCURRENT (default 4, hard ceiling 4) bots AT THE SPOT at any moment: the next bot only starts when a previous one has fully finished and warped away. Each bot sends /tpa to TPA_MAIN_PLAYER, waits for the teleport, deposits its inventory into nearby containers, then resets with /warp afk so the fleet never accumulates in one room. Starts are spaced DUMP_HIDDEN_MIN_GAP_MS–DUMP_HIDDEN_MAX_GAP_MS apart (default 15–45s) so arrivals look organic.',
        examples: ['/dump hidden', '/dump hidden "fatal" shulker', '/dump hidden "sword"']
      },
      {
        title: 'Sizing and timing',
        desc: 'Wall-clock time scales as roster / cap × (dump + settle). For 70 bots at cap 4 expect roughly 30–60 minutes. Lower DUMP_HIDDEN_CONCURRENT to 2 or 3 for an even smaller footprint (the run just takes longer). The cap is enforced by completion, not by timing — a slow dump delays the next bot instead of overlapping it.',
        examples: []
      },
      {
        title: 'Cancelling and recovery',
        desc: '/dump cancel stops the hidden chain: queued bots are dropped, in-flight dumps are asked to stop, and the run reports how many bots completed. Disconnecting a bot cancels its own pending work. Teleport failures release their slot immediately and are logged per bot; nothing gets stuck waiting on a bot that never moved.',
        examples: ['/dump cancel']
      },
      {
        title: 'Algorithm notes',
        desc: 'The design follows three rules: (1) only /tpa to the main player is used for transport — no walking, no shared warps; (2) concurrency is bounded by a slot scheduler whose slots are released only when the bot has left the area; (3) the reset (/warp afk) is part of the slot lifetime, so "finished dumping" and "gone from the spot" are the same event. Possible future tweaks: per-run random cap (2–4), a DUMP_HIDDEN_SPREAD_MS jitter knob, and one automatic retry for failed teleports.',
        examples: []
      }
    ]
  },
  {
    id: 'crates',
    title: '/crates-all & /crates-solo',
    summary: 'shardshop → crates → dump chains, with dump filters and hidden mode',
    entries: [
      {
        title: 'The chain',
        desc: 'Both commands run shardshop (sell off) → crates (click the crate shulker) → dump, either across bots 1..n (/crates-all [n] [color]) or on a single bot (/crates-solo [bot] [color]). Bots start CRATES_ALL_STAGGER_MS apart (default 30s) so they do not hit the server at once.',
        examples: ['/crates-all 5 purple', '/crates-solo B', '/crates-solo 3 red']
      },
      {
        title: 'dump= and afk= flags',
        desc: 'dump=off|tpa|home|hidden|player:<name> chooses the dump step; afk=now|off|<seconds> chooses the AFK warp afterwards. They override CRATES_ALL_DUMP / CRATES_ALL_AFK_WARP / CRATES_ALL_AFK_DELAY_MS for that run. dump=hidden arms the hidden dump chain once for the whole roster — yes, /crates-solo supports it too.',
        examples: ['/crates-all 5 purple dump=off afk=now', '/crates-solo B dump=hidden', '/crates-solo B dump=player:Smith', '/crates-all dump=home afk=off']
      },
      {
        title: 'Dump filters on the chain',
        desc: 'The /dump filter grammar threads through to the dump step: quoted "terms" and bare shulker/chest/all words and shulker colors after the [bot] [color] positionals are dump filters. On these commands quote your terms (the first bare color is the CRATE color positional). Example: /crates-solo B "fatal" shulker dump=hidden runs the chain on B and hands only Fatal-named items to the hidden dump, into shulker boxes.',
        examples: ['/crates-solo B "fatal" shulker dump=hidden', '/crates-all 3 "sword" "enchanted" shulker chest dump=tpa', '/crates-solo B "fatal" shulker yellow dump=hidden']
      }
    ]
  },
  {
    id: 'fleet-controls',
    title: 'Fleet controls, movement & evidence',
    summary: 'Inclusive bot ranges, quiet movement, connection identity, audit history and spawner drops',
    entries: [
      { title: 'Bot ranges', desc: '/all [first-last] <cmd> and /all-slow [first-last] [delay] <cmd> use the displayed inclusive 1–N roster numbers. Exact names can be endpoints: /all Alpha-Bravo /status; name:Alpha..Bravo is unambiguous for hyphenated names. A bare selector previews targets and never changes future selection. Existing no-range syntax still works.', examples: ['/all 40-65', '/all 40-65 /status', '/all-slow 40-65 1500ms /status'] },
      { title: 'Quiet movement', desc: '/coordinates (alias /pos) reports position, facing and dimension. /walk ~2 ~ ~-3 uses current-position offsets on world axes; direction steps are relative to facing. /manual-interact forward [duration] performs one timed press without toggling mode, launching a viewer or sending public chat. MANUAL_STEP_MS defaults to 500; the maximum is 10 seconds. foward is accepted. /manual-interact stop or /walk stop cancels movement. Quiet means no public chat, not concealed network movement or suppressed local errors.', examples: ['/coordinates', '/manual-interact foward 500ms', '/walk ~2 ~ ~-3 0', '/manual-interact stop'] },
      { title: 'Connection address', desc: '/connection and /status label configured Minecraft target, destination IP when verifiable, route and TCP peer separately. For proxied connections the TCP peer is the proxy, not the server. Proxy-resolved destination IP and public egress IP are unknown unless independently verified. No credentials or external IP lookup are included.', examples: ['/connection'] },
      { title: 'Evidence audit', desc: '/evidence shows observed connection events, the last three actual dump runs and their outcome messages, and the last twenty death observations for the selected bot. The authenticated /api/evidence?bot=<name> returns the full untruncated audit. EVIDENCE_FILE defaults to data/evidence.json and survives reconnects/restarts. Historical deaths/dumps cannot be reconstructed. Health transitions and server death packets are separate observations, not a death-count statistic. A death observation does not imply a cause of ban.', examples: ['/evidence', '/all 40-65 /evidence'] },
      { title: 'Spawner drop', desc: '/spawner-drop ["term" ...] [duration=60s] [cooldown=10s] [mode=duration|once|until-stop] [scope=all|inventory|gui] opens the nearest in-reach spawner, stays still, faces it and drops matching whole stacks including already-carried items. Default bones, one confirmed stack every ten seconds for sixty seconds. Name/NBT terms are OR matched. scope=all includes server GUI slots. Server plugins may reject GUI throw clicks: unchanged slots/timeouts stop the run without retries. No sell/claim buttons are clicked. mode=once processes initially matching slots once; until-stop requires explicit stop. In-flight packets cannot be unsent.', examples: ['/spawner-drop bones duration=2min cooldown=10s', '/spawner-drop "bone" scope=gui mode=once', '/spawner-drop stop', '/run-script spawner-drop'] }
    ]
  },
  {
    id: 'settings',
    title: 'Settings & environment',
    summary: 'The knobs behind /dump and the chains (full list in the .ENV tab)',
    entries: [
      {
        title: 'Dump core',
        desc: 'TPA_MAIN_PLAYER — the /tpa target for dumps (TPA_TARGET_PLAYER is a legacy alias). DUMP_HOME_COMMAND — the /home command for dump=home (default /home stash). WARP_COMMAND — the AFK reset warp (default /warp afk). DUMP_TPA_TIMEOUT_MS (45000) — how long to wait for the teleport; DUMP_TPA_MIN_DISTANCE (10) — blocks of movement that count as "teleported". DUMP_SETTLE_MS (2500) — pause after teleporting before scanning; DUMP_WARP_DELAY_MS (2500) — pause after dumping before the AFK warp.',
        examples: []
      },
      {
        title: 'Dump mechanics',
        desc: 'DUMP_CLICK_DELAY_MS (120) — pause between shift-clicks; DUMP_CLICK_CONFIRM_MS (1500) — how long to wait for the server to confirm a click moved the stack (fixes "only dumps a little"); DUMP_OPEN_TIMEOUT_MS (15000) — give up on a container that will not open. CHEST_SCAN_RADIUS (30) and CHEST_SCAN_COUNT (50) bound the container search.',
        examples: []
      },
      {
        title: 'Hidden dump',
        desc: 'DUMP_HIDDEN_CONCURRENT (default 4, max 4) — bots allowed at the spot at once. DUMP_HIDDEN_MIN_GAP_MS (15000) / DUMP_HIDDEN_MAX_GAP_MS (45000) — random gap between starts. Lower the cap for a quieter run; the run finishes when the queue is empty, not on a timer.',
        examples: []
      },
      {
        title: 'Crates chain defaults',
        desc: 'CRATES_ALL_DUMP (tpa) — default dump step: off|tpa|home|hidden|player:<name>. CRATES_ALL_AFK_WARP (true) / CRATES_ALL_AFK_DELAY_MS (15000) — the AFK step afterwards. CRATES_ALL_STAGGER_MS (30000) — gap between bots starting. Per-run dump= / afk= flags always win.',
        examples: []
      },
      {
        title: 'Temporary overrides',
        desc: 'The .ENV tab (web GUI) and /env change settings for the RUNNING process only — nothing is written to .env and a restart forgets them. Keys marked startup-only were read once at boot; editing them needs a restart.',
        examples: ['/env list DUMP', '/env set DUMP_HIDDEN_CONCURRENT 2', '/env reset DUMP_HIDDEN_CONCURRENT']
      }
    ]
  },
  {
    id: 'web-gui',
    title: 'Web GUI & API',
    summary: 'The dashboard panels and the JSON endpoints behind them',
    entries: [
      {
        title: 'Panels',
        desc: 'ALL/SYSTEM/bot channels for logs; TERMINAL for the SSH shell (when enabled); .ENV for temporary settings; COINFLIP for fleet analytics; 📚 docs (this documentation, also opened by typing /doc in the command bar); ? cmds for the quick command list. The /play tab embeds the self-hosted Minecraft web client.',
        examples: []
      },
      {
        title: 'JSON endpoints',
        desc: '/api/state (logs, bots, stats, command list) · /api/command (run a command) · /api/settings, /api/settings/reset (.ENV tab) · /api/docs (this documentation) · /api/analytics, /api/coinflip[/deep|/summary|/fairness|/bots], /api/timeseries, /api/export (analytics) · /api/tor/newnym (fresh Tor circuits). All require the dashboard login cookie.',
        examples: []
      },
      {
        title: 'find — fleet-wide item search',
        desc: '/find <name> ["name" ...] scans every bot\'s inventory AND any open window and lists matches with bot, slot and location. Matching is the same engine as /dump filters: display/custom/registry names plus NBT, case-insensitive, multiple quoted terms OR\'d.',
        examples: ['/find sword', '/find "fatal" "enchanted"']
      }
    ]
  },
  {
    id: 'automation',
    title: 'Automation',
    summary: 'Repeats, broadcasts, cron, and bot-scripts',
    entries: [
      {
        title: '/repeat and /all-slow',
        desc: '/repeat [n|duration] [delay] <cmd> re-runs a command with a gap (REPEAT_DELAY_MS). /all-slow [first-last] [delay] <cmd> broadcasts to the selected inclusive range (or every bot) staggered (ALL_SLOW_DELAY_MS), with a chat guard so plain chat cannot be sprayed by accident (prefix ! to send deliberately). /all-slow-cancel [id] stops a broadcast.',
        examples: ['/repeat 5 30s /spawners', '/all-slow 30 /crates', '/all-slow !hello']
      },
      {
        title: 'Cron jobs',
        desc: '/cron list · /cron add <schedule> <cmd> · /cron rm <id> · /cron on|off <id> · /cron run <id>. Schedules are 5-field cron or @every <secs>; @BotName targets one bot. Jobs persist in CRON_STATE_FILE and reload on restart. Chains work inside a job command.',
        examples: ['/cron add "0 */2 * * *" /dump "fatal"', '/cron add @every 600 @BotA /status']
      },
      {
        title: 'Bot-scripts',
        desc: 'bot-scripts/<name>.txt files are plain command lists, one per line, # comments skipped. "*<fragment> <cmd>" targets every bot whose name contains the fragment, "* <cmd>" targets all bots, a bare line runs on the invoking bot. /scripts lists them, /run-script <name> runs one.',
        examples: ['/run-script example']
      }
    ]
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    summary: 'When something does not move, teleport, or log in',
    entries: [
      {
        title: 'A dump says "nothing to dump" or "no items match"',
        desc: 'The inventory is empty, or no item matches your terms. Quoted terms are OR\'d and match names + NBT; check /find <term> first to see what the fleet actually holds. A filtered dump never teleports when nothing matches — that is intentional.'
      },
      {
        title: 'The hidden dump will not start',
        desc: 'It needs TPA_MAIN_PLAYER set in .env, and it refuses to run twice concurrently (/dump cancel clears the old run). Bots that are disconnected are skipped and logged. /dump cancel reports how many bots completed.'
      },
      {
        title: 'A bot will not teleport or a container will not open',
        desc: 'Teleport waits DUMP_TPA_TIMEOUT_MS then scans anyway (with a warning). Containers that never open are abandoned after DUMP_OPEN_TIMEOUT_MS and the dump moves on. Persistent failures: check the bot is spawned (/status), and whether the server denied /tpa (cooldown or full inventory).'
      },
      {
        title: 'Login / register failures',
        desc: 'A rejected password stops the bot from retrying (a wrong password retried is how accounts get banned). The /status output names the variable the password came from (never the value). Fix the config, then /auth-retry <bot>.'
      },
      {
        title: 'Tor / proxies',
        desc: '/proxy shows each bot\'s resolved route. /tor-newnym (or the ⟳ tor button) requests fresh circuits from every local Tor instance; live connections keep their circuit until they reconnect. PROXY_GROUP_<N>_* variables group bots onto dedicated proxies and passwords.'
      }
    ]
  }
]

// The command reference is generated from the live COMMANDS map at request
// time — it can never drift from what /help shows.
function commandReferenceSection (commands) {
  const entries = Object.entries(commands || {}).map(([cmd, desc]) => ({ title: cmd, desc: String(desc || '') }))
  return {
    id: 'commands',
    title: 'Command reference',
    summary: 'Every command and what it does (generated from /help)',
    entries
  }
}

function buildDocs ({ commands } = {}) {
  return [...SECTIONS, commandReferenceSection(commands)]
}

// The shape /api/docs serves and the web-GUI panel renders.
function docsForApi ({ commands } = {}) {
  return { generatedAt: new Date().toISOString(), sections: buildDocs({ commands }) }
}

function docsIndexText () {
  const lines = ['Documentation — /doc <topic> opens a section, /doc lists this index.', '']
  for (const s of SECTIONS) lines.push(` ${s.id} — ${s.title}: ${s.summary}`)
  lines.push(' commands — Command reference: every command and what it does')
  lines.push('')
  lines.push(' Tip: the web GUI has the same docs in the 📚 docs panel (searchable).')
  return lines
}

// Topic matching is deliberately loose: section id, title and summary, plus
// entry titles — "shulker", "hidden" and "dump=hidden" all land somewhere useful.
function docsSectionText (topic) {
  const q = String(topic || '').toLowerCase().trim()
  if (!q) return docsIndexText()
  const sections = buildDocs().filter(s =>
    `${s.id} ${s.title} ${s.summary}`.toLowerCase().includes(q) ||
    s.entries.some(e => `${e.title} ${e.desc}`.toLowerCase().includes(q))
  )
  const lines = []
  for (const s of sections) {
    lines.push(`── ${s.title} (${s.id}) ──`)
    for (const e of s.entries) {
      lines.push(` ${e.title}`)
      lines.push(`   ${e.desc}`)
      for (const ex of e.examples || []) lines.push(`   ❯ ${ex}`)
    }
    lines.push('')
  }
  return lines
}

module.exports = { SECTIONS, buildDocs, docsForApi, docsIndexText, docsSectionText }
