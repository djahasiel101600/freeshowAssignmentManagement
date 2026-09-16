#!/usr/bin/env python3
"""
FreeShow SMS Manager - Receiver
===============================

Lightweight HTTP server for the deployment machine (Ubuntu server, behind a
cloudflared tunnel). Three jobs:

1. Receive variable snapshots pushed by the FreeShow bridge
   (POST /api/variables, authenticated with BRIDGE_TOKEN).
2. Serve variables to the web app (GET /api/variables) and accept
   variable-edit commands (POST /api/commands) that the bridge applies
   to FreeShow.
3. Serve the built React app (dist/) and reverse-proxy /semaphore and
   /webhook traffic that the Vite dev server used to handle.

Run:  uvicorn app:app --host 127.0.0.1 --port 8000   (from this directory)
Config: see .env.example
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent


def _load_env() -> None:
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_env()

BRIDGE_TOKEN = os.environ.get("BRIDGE_TOKEN", "").strip()
APP_TOKEN = os.environ.get("APP_TOKEN", "").strip()
SEMAPHORE_TARGET = os.environ.get("SEMAPHORE_TARGET", "https://api.semaphore.co/api/v4").rstrip("/")
WEBHOOK_TARGET = os.environ.get("WEBHOOK_TARGET", "https://n8n.jdp-homelab.space").rstrip("/")
WEBHOOK_PATH_PREFIX = os.environ.get(
    "WEBHOOK_PATH_PREFIX", "/webhook/a94af661-17a6-43a7-8540-21f510d19946"
)
DATA_DIR = Path(os.environ.get("DATA_DIR", str(BASE_DIR / "data")))
VARIABLES_FILE = DATA_DIR / "variables.json"
COMMANDS_FILE = DATA_DIR / "commands.json"
DIST_DIR = Path(os.environ.get("DIST_DIR", str(BASE_DIR.parent / "dist")))
COMMAND_MAX_AGE_HOURS = float(os.environ.get("COMMAND_MAX_AGE_HOURS", "24"))

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("receiver")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_write(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp-{uuid.uuid4().hex[:8]}")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(tmp, path)

class Store:
    """Thread-safe holder for the latest variable snapshot and the command queue."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.variables: list[dict[str, Any]] = []
        self.updated_at: Optional[str] = None
        self.source: Optional[str] = None
        self.commands: list[dict[str, Any]] = []
        self.started_at = time.time()
        self._load()

    def _load(self) -> None:
        try:
            if VARIABLES_FILE.exists():
                data = json.loads(VARIABLES_FILE.read_text(encoding="utf-8"))
                self.variables = data.get("variables", [])
                self.updated_at = data.get("updatedAt")
                self.source = data.get("source")
                log.info("Restored %d variables from %s", len(self.variables), VARIABLES_FILE)
        except Exception as exc:  # noqa: BLE001
            log.warning("Could not restore variables (%s)", exc)
        try:
            if COMMANDS_FILE.exists():
                self.commands = json.loads(COMMANDS_FILE.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            log.warning("Could not restore commands (%s)", exc)

    def set_snapshot(
        self,
        variables: list[dict[str, Any]],
        source: Optional[str],
        changed: Optional[list[dict[str, Any]]],
    ) -> int:
        with self._lock:
            self.variables = variables
            self.updated_at = _utc_now_iso()
            self.source = source
            _atomic_write(
                VARIABLES_FILE,
                {
                    "variables": self.variables,
                    "changed": changed or [],
                    "updatedAt": self.updated_at,
                    "source": self.source,
                },
            )
            return len(variables)

    def get_snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "variables": self.variables,
                "updatedAt": self.updated_at,
                "source": self.source,
            }

    def add_command(self, variable_id: str, value: str) -> dict[str, Any]:
        with self._lock:
            command = {
                "id": uuid.uuid4().hex,
                "variableId": variable_id,
                "value": value,
                "createdAt": _utc_now_iso(),
                "status": "pending",
            }
            self.commands.append(command)
            self._cleanup_locked()
            _atomic_write(COMMANDS_FILE, self.commands)
            return command

    def pending_commands(self) -> list[dict[str, Any]]:
        with self._lock:
            self._cleanup_locked()
            return [c for c in self.commands if c["status"] == "pending"]

    def ack_commands(self, ids: list[str]) -> int:
        with self._lock:
            acked = 0
            now = _utc_now_iso()
            for command in self.commands:
                if command["id"] in ids and command["status"] == "pending":
                    command["status"] = "applied"
                    command["appliedAt"] = now
                    acked += 1
            _atomic_write(COMMANDS_FILE, self.commands)
            return acked

    def _cleanup_locked(self) -> None:
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=COMMAND_MAX_AGE_HOURS)).isoformat()
        self.commands = [
            c
            for c in self.commands
            if c.get("status") == "pending" or c.get("appliedAt", c.get("createdAt", "")) >= cutoff
        ]

    def stats(self) -> dict[str, Any]:
        with self._lock:
            pending = sum(1 for c in self.commands if c["status"] == "pending")
            return {
                "ok": True,
                "variableCount": len(self.variables),
                "lastSyncAt": self.updated_at,
                "source": self.source,
                "pendingCommands": pending,
                "uptimeSeconds": round(time.time() - self.started_at, 1),
            }


store = Store()

def check_bridge_token(token: Optional[str]) -> None:
    if BRIDGE_TOKEN and token != BRIDGE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing bridge token")


def check_app_token(token: Optional[str]) -> None:
    if APP_TOKEN and token != APP_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing app token")


app = FastAPI(title="FreeShow SMS Manager Receiver", version="1.0.0")

proxy_client = httpx.AsyncClient(timeout=httpx.Timeout(20.0))

HOP_BY_HOP = {
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "x-bridge-token",
    "x-app-token",
    "accept-encoding",
}


async def _forward(request: Request, url: str) -> Response:
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP}
    body = await request.body()
    try:
        upstream = await proxy_client.request(
            request.method,
            url,
            content=body,
            headers=headers,
            params=dict(request.query_params),
        )
    except httpx.HTTPError as exc:
        log.error("Proxy error for %s: %s", url, exc)
        return JSONResponse({"error": f"Upstream request failed: {exc}"}, status_code=502)
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
    )


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return store.stats()


@app.post("/api/variables")
async def post_variables(
    request: Request,
    x_bridge_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    check_bridge_token(x_bridge_token)
    try:
        payload = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Body must be valid JSON") from exc

    variables = payload.get("variables") if isinstance(payload, dict) else None
    if not isinstance(variables, list):
        raise HTTPException(status_code=400, detail="'variables' must be a list")

    source = payload.get("source") if isinstance(payload, dict) else None
    changed = payload.get("changed") if isinstance(payload, dict) else None
    count = store.set_snapshot(variables, source=source, changed=changed)
    log.info("Snapshot stored: %d variables (source=%s, changed=%d)", count, source, len(changed or []))
    return {"ok": True, "count": count, "updatedAt": store.get_snapshot()["updatedAt"]}


@app.get("/api/variables")
async def get_variables() -> dict[str, Any]:
    return store.get_snapshot()


@app.post("/api/commands")
async def post_command(
    request: Request,
    x_app_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    check_app_token(x_app_token)
    try:
        payload = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Body must be valid JSON") from exc

    variable_id = payload.get("variableId")
    value = payload.get("value")
    if not variable_id or value is None:
        raise HTTPException(status_code=400, detail="'variableId' and 'value' are required")

    command = store.add_command(str(variable_id), str(value))
    log.info("Command queued %s -> variable %s", command["id"][:8], variable_id)
    return {"ok": True, "commandId": command["id"], "queuedAt": command["createdAt"]}


@app.get("/api/commands")
async def get_commands(
    x_bridge_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    check_bridge_token(x_bridge_token)
    return {"commands": store.pending_commands()}


@app.post("/api/commands/ack")
async def ack_commands(
    request: Request,
    x_bridge_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    check_bridge_token(x_bridge_token)
    try:
        payload = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Body must be valid JSON") from exc
    ids = payload.get("ids", []) if isinstance(payload, dict) else []
    if not isinstance(ids, list):
        raise HTTPException(status_code=400, detail="'ids' must be a list")
    acked = store.ack_commands([str(i) for i in ids])
    return {"ok": True, "acked": acked}

# --------------------------------------------------------------------------
# Reverse proxies (parity with the old Vite dev proxies)
# --------------------------------------------------------------------------


@app.api_route("/semaphore/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
async def semaphore_proxy(path: str, request: Request) -> Response:
    check_app_token(request.headers.get("x-app-token"))
    return await _forward(request, f"{SEMAPHORE_TARGET}/{path}")


@app.api_route("/semaphore", methods=["GET", "POST"])
async def semaphore_proxy_root(request: Request) -> Response:
    check_app_token(request.headers.get("x-app-token"))
    return await _forward(request, SEMAPHORE_TARGET)


if WEBHOOK_TARGET:
    webhook_prefix = WEBHOOK_PATH_PREFIX.rstrip("/")

    @app.api_route("/webhook/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
    async def webhook_proxy(path: str, request: Request) -> Response:
        return await _forward(request, f"{WEBHOOK_TARGET}{webhook_prefix}/{path}")

    @app.api_route("/webhook", methods=["GET", "POST"])
    async def webhook_proxy_root(request: Request) -> Response:
        return await _forward(request, f"{WEBHOOK_TARGET}{webhook_prefix}")


# --------------------------------------------------------------------------
# Static SPA serving (built frontend from ../dist)
# --------------------------------------------------------------------------

if (DIST_DIR / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")
else:
    log.warning(
        "dist/ not found at %s - run `npm run build` so the SPA can be served", DIST_DIR
    )


@app.get("/{full_path:path}", include_in_schema=False)
async def spa(full_path: str) -> Response:
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")
    candidate: Optional[Path] = None
    if full_path:
        resolved = (DIST_DIR / full_path).resolve()
        try:
            resolved.relative_to(DIST_DIR.resolve())
            candidate = resolved
        except ValueError:
            candidate = None
    if candidate and candidate.is_file():
        return FileResponse(candidate)
    index_file = DIST_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return JSONResponse(
        {"error": "Frontend build not found. Run `npm run build` first."}, status_code=503
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8000")),
    )