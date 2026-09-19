# Deployment Guide

Deploy the FreeShow SMS Manager so the web app runs on an **Ubuntu server**
(reachable through a **cloudflared tunnel**) while only a small Python bridge
runs next to **FreeShow** on your desktop.

## Architecture

```
PARROT OS (FreeShow machine)                     UBUNTU SERVER (cloudflared tunnel)
────────────────────────────────┐               ┌──────────────────────────────────┐
│ FreeShow  (API on :5505)       │               │ freeshow-receiver (systemd)      │
│   ▲ HTTP  change_variable      │  POST snap    │   POST /api/variables ── bridge  │
│   │                            │──────────────►│   GET  /api/variables ◄─ browser │
│    WS + HTTP get_variables    │               │   POST /api/commands  ◄─ browser │
│                                │  GET commands │   GET  /api/commands  ◄─ bridge  │
│ freeshow-bridge (systemd) ─────┼──────────────►│   /semaphore/* → api.semaphore.co│
└────────────────────────────────┘   apply + ack │   /webhook/*   → n8n             │
                                                 │   /*           → dist/ (SPA)     │
                                                 └───────────────┬──────────────────┘
                                                    [Browser] ───┘ /api/variables (10s)
```

**Two data lanes**

1. **Sync (bridge → server):** FreeShow's variables are watched via WebSocket
   (with an HTTP poll as a guaranteed fallback), diffed, and POSTed as a full
   snapshot.
2. **Commands (server → bridge):** variable edits made in the web app are
   queued and applied to FreeShow by the bridge.

Because the snapshot is the source of truth, a restart of any component
self-heals: the bridge re-pushes everything it sees.

## 1. Server prerequisites

```bash
sudo apt update
sudo apt install -y python3-venv nodejs npm
node -v   # 18+ recommended
```

## 2. Deploy the app + receiver

```bash
sudo mkdir -p /opt/freeshow-sms && sudo chown $USER /opt/freeshow-sms
# copy the project (git clone / rsync / scp) into /opt/freeshow-sms

cd /opt/freeshow-sms
npm ci
npm run build                       # produces dist/ that the receiver serves

cd server
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
cp .env.example .env
```

Generate the secrets and fill in `.env`:

```bash
openssl rand -hex 32   # BRIDGE_TOKEN  (paste into server/.env AND bridge/.env)
openssl rand -hex 32   # APP_TOKEN     (paste into server/.env, then into Settings)
```

`server/.env` should end up looking like:

```ini
BRIDGE_TOKEN=<the first random hex>
APP_TOKEN=<the second random hex>
## 3. Run the receiver as a service

```bash
sudo useradd -r -s /usr/sbin/nologin freeshow
sudo chown -R freeshow:freeshow /opt/freeshow-sms/server/data
sudo cp server/freeshow-receiver.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now freeshow-receiver
sudo journalctl -u freeshow-receiver -f
```

Check it locally before involving the tunnel:

```bash
curl -s http://127.0.0.1:8000/api/health
```

## 4. Point cloudflared at it

Add an ingress rule to your tunnel config (`~/.cloudflared/config.yml` or the
dashboard):

```yaml
ingress:
  - hostname: sms.your-domain.example
    service: http://127.0.0.1:8000
  - service: http_status:404
```

```bash
sudo systemctl restart cloudflared
curl -s https://sms.your-domain.example/api/health
```

Recommended: protect the hostname with **Cloudflare Access** as well.

## 5. Deploy the bridge on the FreeShow machine

```bash
cd ~/Documents/FreeShow/Script/freeshowAssignmentManagement/bridge
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
cp .env.example .env
```

Edit `bridge/.env`:

```ini
SERVER_URL=https://sms.your-domain.example
BRIDGE_TOKEN=<same value as server/.env>
```

Test it in the foreground — you should see a line like
`Synced 8 variables to server (trigger=startup, initial)`:

```bash
./venv/bin/python freeshow_bridge.py --verbose
```

Then install the user service:

```bash
mkdir -p ~/.config/systemd/user
cp freeshow-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now freeshow-bridge
loginctl enable-linger $USER
journalctl --user -u freeshow-bridge -f
```

## 6. First-run setup in the app

1. Open `https://sms.your-domain.example` and **Sign in** (first start creates
   the admin account — see *First sign-in* above; without `ADMIN_PASSWORD` the
   generated one is printed once in the service logs: `journalctl -u freeshow-server`).
2. **Settings → Bridge & Server** — the card should read **Receiver online** with
   a recent *Last sync*. Paste the `APP_TOKEN` and press **Save Settings**.
3. **Settings → Semaphore SMS** — enter your API key + registered sender name,
   then press **Test Connection**. (Semaphore + webhook settings are stored on
   the server now, so they follow every account/device.)
4. **Settings → Data Backup & Restore** — use **Import Backup** to restore
   contacts/templates/rules/history from an old backup file. Everything lives in
   the receiver's database now, so data follows you to any browser after you
   sign in — no per-device copy needed.
5. **Variables** tab — confirm your FreeShow variables appear.
6. **Rotation → Tracked variables** — list the FreeShow variable names (or name
   patterns, e.g. `schedule_`) whose values represent a person's assignment.
   From then on the bridge's snapshots write every change into the **Schedule**
   ledger automatically.
7. **Schedule** tab — the assignment history (who was assigned, on which day,
   from which source). **Rotation** tab — cycle detection: turn counts, median
   gaps, rotation order, and who is expected next.
## 7. Verification checklist

| # | Test | Expected |
|---|---|---|
| 1 | Change a variable in FreeShow | app shows it within ~5s |
| 2 | Edit a variable in the app | FreeShow updates within ~10s, then all browsers converge |
| 3 | Restart the receiver | variables still present (from `variables.json`) |
| 4 | Stop the bridge | app shows stale data + `pendingCommands` grows; SMS still sends with last-known values |
| 5 | Start the bridge again | queued edits apply, snapshot re-syncs |
| 6 | Send 3 SMS from Conditional | 3 rows in History |
| 7 | `POST /api/commands` without the app token | `401` |

## Operations

```bash
# logs
sudo journalctl -u freeshow-receiver -n 100 --no-pager
journalctl --user -u freeshow-bridge -n 100 --no-pager

# restart after a code change
cd /opt/freeshow-sms && npm run build && sudo systemctl restart freeshow-receiver

# state files
ls -l /opt/freeshow-sms/server/data     # variables.json, commands.json
```

### Updating the app

```bash
cd /opt/freeshow-sms && git pull && npm ci && npm run build
sudo systemctl restart freeshow-receiver
```

The receiver picks up the new `dist/` on restart; no bridge change is needed.

## Docker Compose (alternative deployment)

If you prefer containers over the systemd units above, `docker-compose.yml`
bundles **both** the web frontend (nginx serving the built SPA) and the
receiver (`server/app.py`) on a private network. The FreeShow bridge still
runs on the FreeShow machine — it is **not** containerized, because it must be
able to reach FreeShow on `localhost:5505`.

### One-time setup

```bash
sudo apt update
sudo apt install -y docker.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
# your host must already have the shared network all your projects use:
docker network ls                     # you should see "jdp-network"
```

Generate secrets once, then paste the hex into `server/.env` (and the same
`BRIDGE_TOKEN` later into `bridge/.env`):

```bash
openssl rand -hex 32   # BRIDGE_TOKEN
openssl rand -hex 32   # APP_TOKEN  (also paste into the app's Settings -> Server)
```

Copy the committed env templates — `.env.example` is **pre-set for
`jdp-network`**, so there's no YAML editing to reach the shared network:

```bash
cp .env.example .env            # already sets JDP_NETWORK_EXTERNAL=true / jdp-network
cp server/.env.example server/.env
# edit server/.env -> BRIDGE_TOKEN, APP_TOKEN, ADMIN_PASSWORD, SEMAPHORE_TARGET,
#                     WEBHOOK_TARGET, SESSION_COOKIE_SECURE=true, SCHEDULE_TZ
```

With `.env` in place, **plain `docker compose up -d --build` attaches both
services to your existing `jdp-network`** and creates **no** extra network.
The frontend is then reachable from any other container on `jdp-network`
(cloudflared, your other projects) as `freeshow-frontend:80`.

### Build & run

```bash
docker compose up -d --build     # builds both images, starts both services
docker compose logs -f           # tail both services
```

- Frontend: `http://<server-ip>` (nginx on :80).
- Receiver API: `http://<server-ip>/api/health` (proxied through nginx).

Both services share one isolated network; the receiver is **not** published to
the host — only the frontend is.

### Joining an existing Docker network (e.g. `jdp-network`) — the default

This is the **default** for this project: `.env.example` already ships
`JDP_NETWORK_EXTERNAL=true` / `JDP_NETWORK_NAME=jdp-network` (copied in the step
above). You only need to touch network names here if your shared network isn't
called `jdp-network`.

To join a network with a different name, override it in `.env` (Compose reads it
automatically):

```bash
cat > .env <<'EOF'
FRONTEND_PORT=80
JDP_NETWORK_EXTERNAL=true
JDP_NETWORK_NAME=your-other-network
EOF
```

Then: `docker compose up -d --build` — both services attach to that network and
**no** extra/throwaway network is created. Set `JDP_NETWORK_EXTERNAL=false` to
let Compose make a private isolated network instead.

### State & data

Everything persistent lives in the named volume `freeshow-sms-server-data`
(mounted at `/app/data` inside the receiver) and survives restarts and image
upgrades:

| File | Contents |
| --- | --- |
| `freeshow.db` | SQLite database — users, sessions, contacts, templates, rules, message history, **assignment ledger**, settings |
| `variables.json` | latest variable snapshot from the bridge |
| `commands.json` | in-flight variable-edit commands |

To wipe state: `docker compose down -v` (removes containers, network **and**
volume). To back up just the data: use the app's **Settings → Data Backup &
Restore → Export All**, or copy the volume contents (`docker run --rm -v
freeshow-sms-server-data:/data alpine tar cz -C /data .`).

### First sign-in (accounts & sessions)

The app is now behind a login. On first start the receiver creates the admin
account from `ADMIN_USERNAME`/`ADMIN_PASSWORD` in `server/.env` (if
`ADMIN_PASSWORD` is empty, a random one is generated and printed **once** in
`docker compose logs server` — change it right away):

1. Open the app → **Sign in** with the admin account.
2. **Account** tab — change your password here (other sessions are revoked),
   review active sessions, and (as admin) create more accounts with
   `user` or `admin` roles.
3. Prefer `SESSION_COOKIE_SECURE=true` in `server/.env` since traffic arrives
   over HTTPS through the Cloudflare tunnel (set it before the first start;
   changing it later just requires a container restart).


### Point cloudflared at the stack

`cloudflared` terminates TLS and forwards **plain HTTP** to the frontend (nginx
on :80) — nginx itself does **not** need a certificate. Pick one option below.

> **Zero Trust dashboard note:** a tunnel's **Routes** entry in the Cloudflare
> dashboard only binds a Cloudflare hostname/CNAME *to the tunnel* (that's the
> DNS side). It does **not** define where traffic is forwarded — the **ingress**
> rule (`hostname → http://<origin>:<port>`) must come from the tunnel's
> `config.yml` **or** the `--url`/`--hostname` run flags (Option C). So you can't
> skip configuration entirely; you can only avoid a config file with quick-run mode.

Whichever you choose, keep the **bridge** (running on the FreeShow machine)
pointing at the **public** URL so it POSTs where the tunnel forwards
(`frontend → server`):

```bash
python3 freeshow_bridge.py --server-url https://sms.your-domain.example ...
#                             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
#                             must be the public https URL, NOT localhost
```

#### Option A — cloudflared as a host service (simplest, recommended)

Run the tunnel on the Ubuntu host; it reaches the frontend's published port
(`FRONTEND_PORT=80` in `.env`). The frontend is the only container that needs
a host port.

```bash
# install once (Cloudflare's package or a direct binary download)
cloudflared tunnel login
cloudflared tunnel create freeshow-sms
```

`/etc/cloudflared/config.yml`:

```yaml
tunnel: freeshow-sms
credentials-file: /etc/cloudflared/freeshow-sms.json

ingress:
  - hostname: sms.your-domain.example
    service: http://127.0.0.1:80            # 127.0.0.1: host -> frontend(:80)
    originRequest:
      http2: true                           # backend speaks HTTP/1.1, HTTP/2 ok
  - service: http_status:404                 # catch-all fallback
```

Run it as a systemd unit (the `cloudflared` package ships one) or manually:

```bash
sudo systemctl restart cloudflared
# or: cloudflared tunnel --config /etc/cloudflared/config.yml run freeshow-sms
```

#### Option B — cloudflared as a container on `jdp-network` (no host port needed)

If you attached the stack to your existing `jdp-network`, run cloudflared in a
container on **that same network**. The tunnel can then reach the frontend by
its Compose service name, so the frontend no longer needs to publish :80 to
the host at all (slightly more secure). Drop this into a
`docker-compose.override.yml` (never committed, since it holds your tunnel
credentials):

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    networks:
      - internal
    volumes:
      - ./cloudflared:/etc/cloudflared:ro
    command: tunnel --config /etc/cloudflared/config.yml run freeshow-sms
```

`cloudflared/config.yml` (note the Compose service name as the upstream):

```yaml
tunnel: freeshow-sms
credentials-file: /etc/cloudflared/freeshow-sms.json

ingress:
  - hostname: sms.your-domain.example
        service: http://freeshow-frontend:80
    originRequest:
      http2: true
  - service: http_status:404
```

Then: `docker compose up -d --build` (compose merges the override) and
`docker compose logs -f cloudflared`.

> Tip: the frontend service name is `<project>-frontend` (`freeshow-frontend`
> by default since `name: freeshow` in the compose file). Adjust if
> you change `COMPOSE_PROJECT_NAME`.

#### Option C — quick `docker run`, **no config.yml** (cloudflared already in Docker)

If you don't want to manage a tunnel credentials file or an override compose file,
just run the `cloudflare/cloudflared` image in quick mode: it forwards a single
hostname straight to the frontend container **and** registers the route for you.
The container must join the same Docker network the frontend is on (by default
`freeshow-sms-internal`; use `jdp-network` if you attached the stack to yours, or
the docker-network name shown by `docker network ls`).

```bash
docker run --rm -i --network=freeshow-sms-internal  \   # or: jdp-network
  cloudflare/cloudflared:latest \
    tunnel --url http://freeshow-frontend:80 \
         --hostname sms.your-domain.example
```

- First run opens a browser window at `http://127.0.0.1:<port>` → log in to
  Cloudflare and pick the account. For **headless** servers: run
  `cloudflared tunnel login` once to capture the cert, then add
  `--token <TOKEN>` (from `cloudflared tunnel token create`) to the command above.
- Wrap it with `restart: always` semantics yourself (e.g. a tiny systemd unit, or
  `docker run --restart=unless-stopped`). `--rm` keeps it a clean single-purpose process.
- **Production check:** quick mode runs an *autonomous* (temporary) tunnel. For a
  persistent, restartable tunnel that survives host reboots cleanly, prefer
  **Option A** (host systemd + credentials file) or **Option B** (compose service)
  — they use a named tunnel you create once with `cloudflared tunnel create`.

### Verify the tunnel

```bash
# 1. Receiver behind the tunnel
curl -s https://sms.your-domain.example/api/health
#   -> {"ok":true,"variableCount":...,"pendingCommands":...,"uptimeSeconds":...}

# 2. SPA served by nginx (through the tunnel)
curl -s -o /dev/null -w "%{http_code}\n" https://sms.your-domain.example/         # 200 (index.html)
curl -s -o /dev/null -w "%{http_code}\n" https://sms.your-domain.example/settings # 200 (SPA fallback)

# 3. Healthcheck inside the stack
docker compose ps          # 'server' (healthy) and 'frontend' both 'Up'
```

### Bridge (unchanged)

On the FreeShow machine, run the bridge as in step 5 — but point it at the
public URL instead of localhost:

```bash
python3 freeshow_bridge.py \
  --server-url https://sms.your-domain.example \
  --bridge-token <BRIDGE_TOKEN> \
  --freeshow-http-url http://localhost:5505 \
  --freeshow-ws-url ws://localhost:5505
```

### Operations

| Command | What it does |
|---|---|
| `docker compose stop` | stop both services |
| `docker compose start` | start both services (keeps state) |
| `docker compose down -v` | stop + remove containers, network and volume |
| `docker compose up -d --build` | rebuild images and (re)start (use after code changes) |

> Tip: keep `server/.env` in sync between the systemd and Docker flows — they use
> the same `BRIDGE_TOKEN`/`APP_TOKEN` keys.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Receiver offline" in Settings | `systemctl status freeshow-receiver`; confirm the tunnel points at `127.0.0.1:8000` |
| Variables empty, health `variableCount: 0` | bridge not running / wrong `SERVER_URL` / token mismatch |
| Bridge logs `401` | `BRIDGE_TOKEN` differs between `bridge/.env` and `server/.env` |
| Bridge logs `FreeShow HTTP unreachable` | FreeShow not running, or its API disabled in *Settings → Connections*; try `--freeshow-http-url http://localhost:5506` |
| App edits never reach FreeShow | `ENABLE_COMMANDS` must not be `false` in `bridge/.env` |
| SMS fails with `HTTP 401` | `APP_TOKEN` not entered in the app's Settings |
| SMS fails with a Semaphore code | sender name must be registered (max 11 chars); number must be `+639…` / `09…` |
| `Frontend build not found` | run `npm run build`; verify `DIST_DIR` |
| Changes take ~10s to show in the browser | expected — the UI polls every 10s |

## What is intentionally NOT included

* No database — the receiver persists two JSON files.
* No user accounts — a shared app token plus optional Cloudflare Access.
* Contacts, templates, conditional rules and history stay in browser
  `localStorage`; move them between browsers with **Settings → Data Management**.
* No server-side n8n auto-forwarding yet (phase 2). The `/webhook/*` proxy
  exists for parity, but the browser can also call your n8n URL directly.
```