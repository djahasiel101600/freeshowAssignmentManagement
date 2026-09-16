# FreeShow Variable Bridge

Runs on the machine where **FreeShow** is installed (e.g. your Parrot OS desktop)
and does one job well:

> Watch FreeShow's variables and POST changes to the deployed
> **FreeShow SMS Manager** receiver.

It also applies variable edits queued by the web app back into FreeShow
(disable with `--no-enable-commands`).

```
FreeShow (ws://localhost:5505)          Ubuntu server (cloudflared)
        │                                        │
        │  WS events + HTTP poll                 │
        ▼                                        │
   bridge.py ──POST snapshots──────────────────► /api/variables
        ▲                                        │
        ──────GET pending commands────────────── /api/commands
              POST ack ────────────────────────► /api/commands/ack
```

## Why a bridge at all?

FreeShow's API is only reachable on `localhost:5505`. The web app lives on
another machine (your Ubuntu server), so it cannot talk to FreeShow directly.
The bridge is the only component that needs to be on the same machine as
FreeShow.

## Install

```bash
cd bridge
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
cp .env.example .env      # then edit SERVER_URL + BRIDGE_TOKEN
./venv/bin/python freeshow_bridge.py        # foreground test
```

## Run as a service (recommended)

```bash
mkdir -p ~/.config/systemd/user
cp freeshow-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now freeshow-bridge
loginctl enable-linger $USER        # keep running after logout
journalctl --user -u freeshow-bridge -f
```

Adjust `WorkingDirectory` / `ExecStart` in the unit if the project does not
live at `/home/dj/freeshow-bridge`.

## Configuration

Command-line flags override `.env`. See `.env.example` for the full list.

| Setting | Flag | Env | Default |
|---|---|---|---|
| Receiver base URL | `--server-url` | `SERVER_URL` | *required* |
| Shared secret | `--bridge-token` | `BRIDGE_TOKEN` | — |
| FreeShow REST API | `--freeshow-http-url` | `FREESHOW_HTTP_URL` | `http://localhost:5505` |
| FreeShow WebSocket | `--freeshow-ws-url` | `FREESHOW_WS_URL` | `ws://localhost:5505` |
| WS transport | `--ws-transport` | `WS_TRANSPORT` | `websocket` |
| Apply queued edits | `--enable-commands` / `--no-enable-commands` | `ENABLE_COMMANDS` | on |
| FreeShow poll interval | `--poll-seconds` | `POLL_SECONDS` | `5` |
| Command poll interval | `--command-poll-seconds` | `COMMAND_POLL_SECONDS` | `3` |
| Sync debounce | `--debounce-ms` | `DEBOUNCE_MS` | `500` |
| Heartbeat | `--heartbeat-seconds` | `HEARTBEAT_SECONDS` | `60` |
| Verbose logging | `--verbose` | — | off |

## How syncing works

1. **Triggers** — any of: a WebSocket message from FreeShow, the periodic HTTP
   poll finding a changed value, a command just applied, or a heartbeat timeout.
2. **Debounce** — triggers are coalesced for `DEBOUNCE_MS` so a burst of edits
   results in a single POST.
3. **Diff + POST** — the bridge fetches `get_variables`, diffs against its last
   known state, and POSTs the **full snapshot** to `/api/variables`
   (idempotent and self-healing; a restart re-syncs everything).

## Transport troubleshooting

FreeShow's docs describe a **Socket.IO** endpoint
(`io.connect("http://localhost:5505", { transports: ["websocket"] })`).

* Default `WS_TRANSPORT=websocket` uses a plain WebSocket client.
* If the handshake fails, try `WS_TRANSPORT=socketio` (requires the
  `python-socketio` dependency, already in `requirements.txt`).
* If both fail, use `WS_TRANSPORT=none`. The HTTP poll alone is enough for
  correctness — the WebSocket is only a latency optimisation.

Run with `--verbose` to print the raw payloads FreeShow sends, which is the
quickest way to confirm the exact event shape of your FreeShow version.

### If the HTTP endpoint is unreachable

FreeShow exposes a REST endpoint that must be a **POST** with a JSON body:

```bash
curl -X POST http://localhost:5505 -H 'Content-Type: application/json' \
     -d '{"action":"get_variables"}'
```

Some FreeShow builds serve the REST API on **5506** instead. If port 5505
refuses POSTs, point the bridge at it:

```bash
./venv/bin/python freeshow_bridge.py --freeshow-http-url http://localhost:5506
```

The bridge accepts several response envelopes (`[...]`, `{"data": [...]}`,
`{"variables": [...]}`) so version differences do not break the sync.

## Verifying it works

```bash
# 1. bridge is alive and talking to the receiver
journalctl --user -u freeshow-bridge -n 30

# 2. the receiver saw the snapshot
curl -s https://your-app.example.com/api/health
# -> {"ok":true,"variableCount":8,"lastSyncAt":"...","pendingCommands":0}

# 3. change a variable in FreeShow, then:
curl -s https://your-app.example.com/api/variables
```

## Notes

* Requires FreeShow's WebSocket/REST API to be enabled in
  **FreeShow → Settings → Connections**.
* The bridge holds no database; the receiver owns all persisted state.
* Commands older than `COMMAND_MAX_AGE_HOURS` are dropped by the receiver so a
  long-offline bridge cannot apply stale edits.