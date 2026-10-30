# ECS fleet: three Tor groups + a direct cohort

One Fargate task runs the whole fleet. Inside it, **three Tor instances** listen on
`9050`, `9150` and `9250` (control port = SOCKS + 1), each with its own
`DataDirectory`, so a flagged exit only takes one cohort down. Bots not in any
group connect **direct**, capped at `DIRECT_MAX`.

```
container
├── tor @ 9050/9051  ── proxy group 1 (10 bots)
├── tor @ 9150/9151  ── proxy group 2 (10 bots)
├── tor @ 9250/9251  ── proxy group 3 (10 bots)
└── direct (no proxy) ── up to DIRECT_MAX (20 bots), replaced one-for-one on ban
```

## Files

| File | Purpose |
| --- | --- |
| `Dockerfile.ecs` | App image; bakes `tor`, `ttyd`, the web-client build and `tor-fleet` |
| `tor-fleet.sh` | Start/stop/restart/status one Tor per `TOR_PORTS` port |
| `docker-entrypoint.sh` | Derives the Tor ports from `PROXY_GROUP_<N>_HOST/PORT`, starts them, waits for bootstrap, then execs the app |
| `plan-routes.js` | Deterministic roster → 10/10/10 groups + direct cohort + spare pool |

`restart-tor` in the image restarts **all** instances and waits for each SOCKS
port, so the proxy-stall watchdog cannot leave `:9150` dead while `:9050` works.

## Rebuilding

The build context is the Bot directory with these three files copied to its root:

```sh
ctx=$(mktemp -d)
cp *.js package.json package-lock.json .dockerignore "$ctx/"
mkdir -p "$ctx/scripts" "$ctx/patches"
cp scripts/build-web-client.sh scripts/patch-web-client-enchants.js "$ctx/scripts/"
cp patches/* "$ctx/patches/" 2>/dev/null || rmdir "$ctx/patches"
cp deploy/ecs/{Dockerfile.ecs,docker-entrypoint.sh,tor-fleet.sh} "$ctx/"
aws ecr get-login-password --region us-east-2 \
  | docker login --username AWS --password-stdin 638486126086.dkr.ecr.us-east-2.amazonaws.com
docker build --platform linux/amd64 -f "$ctx/Dockerfile.ecs" \
  -t 638486126086.dkr.ecr.us-east-2.amazonaws.com/onayaprogrammer-myapi:<tag> "$ctx"
docker push 638486126086.dkr.ecr.us-east-2.amazonaws.com/onayaprogrammer-myapi:<tag>
```

`--platform linux/amd64` matters: the task definition pins `X86_64`, and the
`ttyd` static binary is selected per `TARGETARCH`.

## Route plan

```sh
node deploy/ecs/plan-routes.js roster.txt [--per-group 10] [--direct 20] [--bot-max 50]
```

The order is `sha1(lowercased name)`, not roster position, so the same roster
yields the same plan. Preserve the existing plan when adding names: recomputing
it with a changed roster can reassign existing accounts to different groups. Output is `KEY=value` lines for the task definition:
`BOT_NAMES` (groups first, then the direct cohort, then the spare pool),
`PROXY_GROUP_<N>_BOTS/HOST/PORT/TYPE`, `DIRECT_MAX`, `BOT_MAX`, `TOR_PORTS`.

## Verifying a built image

```sh
docker run --rm --platform linux/amd64 --entrypoint sh <image> -c '
  /usr/local/bin/tor-fleet start; sleep 15; /usr/local/bin/tor-fleet status
  /usr/local/bin/restart-tor'
```

Expect three `listening` lines and three `Tor is back on` lines. The entrypoint
additionally waits for `PROGRESS=100` on each control port before starting the
app, so bots never race the bootstrap.

## Runtime behaviour that goes with this layout

- `DIRECT_MAX` (default 20) caps concurrent **connections** on the direct route.
  A banned direct bot frees its slot and the next unused direct name takes it;
  spare names stay in `BOT_NAMES` as the replacement pool.
- When every direct name is banned the dashboard's `direct` chip turns red and a
  toast says the IP is flagged — proxy groups keep running, so the fleet can look
  healthy while that route is dead.
- `/new-gen [count] randomly|direct+random|direct|<N>` routes new names: groups
  only (smallest first), groups + direct (weighted), direct only, or one group.
