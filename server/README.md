# FreeShow SMS Manager — Receiver

The single service you run on the machine that serves the web app (your Ubuntu
server, published through the cloudflared tunnel). It replaces every
`localhost`-dependent part of the old dev setup.

## What it does

| Job | Endpoint |
|---|---|
| Accept variable snapshots from the bridge | `POST /api/variables` (bridge token) |
| Serve variables to the web app | `GET /api/variables` |
| Queue variable edits for the bridge | `POST /api/commands` (app token) |
| Hand pending commands to the bridge | `GET /api/commands` (bridge token) |
| Mark commands applied | `POST /api/commands/ack` (bridge token) |
| Liveness + sync status | `GET /api/health` |
| Proxy Semaphore SMS (API key stays out of the URL) | `/semaphore/*` (app token) |
| Proxy n8n webhooks | `/webhook/*` |
| Serve the built React app (`../dist`) | `/*` |

## Install

```bash
cd server
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
cp .env.example .env
# generate strong secrets:
openssl rand -hex 32      # -> BRIDGE_TOKEN
openssl rand -hex 32      # -> APP_TOKEN
```

Build the frontend first (the receiver serves it):

```bash
cd .. && npm install && npm run build
```

Run it:

```bash
./venv/bin/python app.py                       # reads HOST/PORT from .env
# or
./venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000
```

## Run as a service

```bash
sudo useradd -r -s /usr/sbin/nologin freeshow
sudo cp freeshow-receiver.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now freeshow-receiver
sudo journalctl -u freeshow-receiver -f
```

Then point the cloudflared tunnel at `http://127.0.0.1:8000`.

## Configuration

See `.env.example`. Real environment variables win over the file.

| Variable | Purpose | Default |
|---|---|---|
| `BRIDGE_TOKEN` | Shared secret the bridge must send as `X-Bridge-Token` | *recommended* |
| `APP_TOKEN` | If set, the browser must send `X-App-Token` for commands + SMS | *recommended* |
| `SEMAPHORE_TARGET` | Semaphore API base URL | `https://api.semaphore.co/api/v4` |
| `WEBHOOK_TARGET` | n8n base URL (`""` disables the route) | n8n homelab host |
| `WEBHOOK_PATH_PREFIX` | Webhook path prefix | the existing UUID path |
| `DATA_DIR` | Where `variables.json` / `commands.json` live | `server/data` |
| `DIST_DIR` | Built frontend to serve | `../dist` |
| `COMMAND_MAX_AGE_HOURS` | Drop queued edits older than this | `24` |
| `HOST` / `PORT` | Bind address when run via `python app.py` | `127.0.0.1` / `8000` |

## Security model

* `BRIDGE_TOKEN` protects the snapshot + command-ack endpoints. The bridge holds it.
* `APP_TOKEN` protects the money-spending / state-changing browser endpoints
  (`POST /api/commands`, `/semaphore/*`). It is typed once into the app's
  **Settings → Bridge & Server** card and stored in that browser's
  `localStorage`.
* `GET /api/variables` and `GET /api/health` are open so the UI can render a
  helpful "offline" state. They contain no secrets.
* Put Cloudflare Access in front of the hostname for defence in depth.

## Verifying

```bash
curl -s http://127.0.0.1:8000/api/health
# {"ok":true,"variableCount":0,"lastSyncAt":null,"source":null,"pendingCommands":0,...}

# unauthorised write must be rejected
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8000/api/commands \
     -H 'Content-Type: application/json' -d '{"variableId":"x","value":"y"}'
# 401
```

## Persistence

`data/variables.json` and `data/commands.json` are written atomically
(temp file + `os.replace`) so a crash cannot corrupt them. Restarting the
service restores the last known variables immediately, before the bridge has
reconnected.

## Troubleshooting

| Symptom | Cause |
|---|---|
| App shows "Receiver offline" | service not running / tunnel not pointed at port 8000 |
| Sends fail with `HTTP 401` | `APP_TOKEN` set on the server but not entered in Settings |
| Bridge posts fail with `401` | `BRIDGE_TOKEN` mismatch between bridge `.env` and server `.env` |
| Variables never update | bridge not running on the FreeShow machine (`journalctl --user -u freeshow-bridge`) |
| `Frontend build not found` (503) | run `npm run build` so `../dist` exists |
| `/webhook/*` returns 404 | `WEBHOOK_TARGET` is empty — set it to enable the route |