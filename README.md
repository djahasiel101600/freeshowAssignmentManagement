# FreeShow SMS Manager

A React + TypeScript app for sending SMS to church members using
[FreeShow](https://freeshow.app) variables, powered by the Semaphore SMS API.

## Features

| Feature | Description |
|---|---|
| **Variables** | Browse/search FreeShow variables, group them, and edit values with contact-name suggestions |
| **Messages** | Compose from templates with `{{Variable}}` placeholders and title/value pairs, plus a global header & footer |
| **Conditional** | Match variable values against contact names and send different messages to many people at once |
| **History** | Every send is logged with status, recipient and the rendered message |
| **Contacts** | Contact list with search, nicknames and inline name/number editing |
| **Data Management** | Import/export contacts, templates, conditional rules and history as JSON |
| **Dark mode** | Light / dark / system theme |

## Architecture

FreeShow only exposes a local API, so the app is split in two:

```
FreeShow machine (e.g. Parrot OS)              Deployed host (Ubuntu + cloudflared)
  FreeShow (API :5505)                           receiver (FastAPI, systemd)
  freeshow-bridge (Python, systemd) ──POST─────► /api/variables
                                    ◄──GET────── /api/commands
                                                  /semaphore/* → api.semaphore.co
                                                  /* → dist/ (this frontend)
```

* **`bridge/freeshow_bridge.py`** watches FreeShow (WebSocket + HTTP poll
  fallback), diffs the variables, and POSTs the full snapshot to the server.
  Optionally it also applies variable edits queued by the web app.
* **`server/app.py`** stores the latest snapshot, serves the built frontend,
  proxies Semaphore, and queues variable-edit commands for the bridge.

**Full instructions: [`DEPLOYMENT.md`](./DEPLOYMENT.md).**

## Local development

```bash
npm install
npm run dev          # http://localhost:5173
```

The dev server proxies `/api` to the receiver on `:8000`, plus `/semaphore`
and `/webhook` for parity with production. To work on variables locally, run
the receiver and bridge as well:

```bash
# terminal 2 — receiver
cd server && uvicorn app:app --port 8000

# terminal 3 — bridge (on the machine running FreeShow)
cd bridge && python3 freeshow_bridge.py --server-url http://localhost:8000
```

The app still works without them — you'll just see an offline notice on the
Variables tab, and messaging keeps using the last known values.

## Scripts

```bash
npm run dev      # dev server with HMR
npm run build    # type-check + production build into dist/
npm run preview  # preview the production build
npm run lint     # eslint
```

## Data storage

Contacts, message templates, conditional rules and message history live in the
browser's `localStorage`; use **Settings → Data Management** to move them
between browsers or machines.

FreeShow variables are **not** stored in the browser — they come from the
receiver server, which the bridge keeps in sync.

## Deployment

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the full runbook (systemd units,
cloudflared tunnel, tokens, verification checklist and troubleshooting).