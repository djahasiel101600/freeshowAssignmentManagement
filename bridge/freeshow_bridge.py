#!/usr/bin/env python3
"""
FreeShow Variable Bridge
========================

Runs in the background on the machine where FreeShow itself is installed
(e.g. your parrot OS desktop). It has ONE job:

    Watch FreeShow's variables and POST changes to the deployed
    FreeShow SMS Manager server.

How it works
------------
* Trigger sources (any of them leads to the same debounced sync):
    1. WebSocket messages from FreeShow (best-effort change trigger).
    2. Periodic HTTP polling of FreeShow's `get_variables` action
       (fallback so changes are never missed).
    3. After applying a variable-edit command pulled from the server.
    4. A periodic heartbeat so the server knows the bridge is alive.
* On every sync it diffs against the last known state and POSTs the full
  variables snapshot to  {SERVER_URL}/api/variables  (header X-Bridge-Token).
* If ENABLE_COMMANDS is on, it also polls {SERVER_URL}/api/commands,
  applies each pending edit to FreeShow via its HTTP API
  (action=change_variable), and acks the commands.

Run:  python3 freeshow_bridge.py --server-url https://your-app.example.com
Help: python3 freeshow_bridge.py --help
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit, urlunsplit

import requests

log = logging.getLogger("bridge")

BASE_DIR = Path(__file__).resolve().parent


def _load_env() -> None:
    for env_path in (BASE_DIR / ".env", Path.cwd() / ".env"):
        if not env_path.exists():
            continue
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


_load_env()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_base_url(value: str, name: str = "URL", default_scheme: str = "http") -> str:
    """
    Clean up a user-supplied base URL and fail loudly if it is unusable.

    LLM-assisted typos we have actually seen in the wild:
        http:127.0.0.1:8000      (missing the two slashes)
        127.0.0.1:8000           (missing the scheme)
        http://127.0.0.1:8000/   (trailing slash)
    A bad URL used to surface only as "Invalid URL ... No host supplied"
    repeated forever in the logs, so we normalise + validate it up front.
    """
    raw = (value or "").strip().strip('"').strip("'")
    if not raw:
        return ""

    # Repair "http:host" / "ws:host" (scheme present, slashes missing).
    for scheme in ("http:", "https:", "ws:", "wss:"):
        if raw.startswith(scheme) and not raw.startswith(scheme + "//"):
            raw = f"{scheme}//{raw[len(scheme):].lstrip('/')}"
            break

    # Bare "host:port" gets the default scheme.
    if "://" not in raw:
        raw = f"{default_scheme}://{raw}"

    parts = urlsplit(raw)
    if not parts.scheme or not parts.netloc:
        raise SystemExit(
            f"\n{name} is not a valid URL: {value!r}\n"
            "  Include the scheme and host, for example:\n"
            f"    --{name.lower().replace('_', '-')} http://127.0.0.1:8000\n"
        )

    return urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/"), "", ""))


def mask_secret(value: str) -> str:
    """Show just enough of a token to confirm it without leaking it to logs."""
    if not value:
        return "(empty)"
    if len(value) <= 8:
        return "***"
    return f"{value[:4]}...{value[-4:]}"


def _network_hint(exc: BaseException) -> str:
    """
    Turn a transport exception into one actionable line.

    Without this, a mistyped URL or a stopped receiver produced the same
    opaque "POST to server failed" line forever, which is very hard to
    diagnose from journalctl alone.
    """
    if isinstance(exc, requests.exceptions.InvalidURL):
        return (
            "\n  -> The URL is malformed. It needs the scheme AND host,"
            "\n     e.g. http://127.0.0.1:8000   (note the two slashes)"
        )
    if isinstance(exc, requests.exceptions.SSLError):
        return (
            "\n  -> TLS failed. Use http:// for a local receiver, or point"
            "\n     SERVER_URL at your https:// (cloudflared) hostname"
        )
    if isinstance(exc, requests.exceptions.Timeout):
        return (
            "\n  -> The receiver did not respond in time. Check it is running"
            "\n     and reachable from this machine."
        )
    if isinstance(exc, requests.exceptions.ConnectionError):
        lowered = str(exc).lower()
        if "name or service not known" in lowered or "nodename nor servname" in lowered:
            return "\n  -> DNS lookup failed; the host address is probably misspelled."
        if "refused" in lowered:
            return (
                "\n  -> Nothing is listening on that address. Is the receiver up?"
                "\n     systemctl status freeshow-receiver"
                "\n     curl http://127.0.0.1:8000/api/health"
            )
        return (
            "\n  -> Could not reach the receiver. Check the host/port and that"
            "\n     the receiver (and the cloudflared tunnel) are running."
        )
    return ""


def extract_variables(data: Any) -> Optional[list[dict[str, Any]]]:
    """
    Pull the variables list out of a FreeShow response, tolerating the
    different shapes FreeShow versions/transports may return:

        [ {...}, {...} ]                    -> as-is
        {"data": [ ... ]}                   -> unwrapped
        {"variables": [ ... ]}              -> unwrapped
        {"data": {"variables": [ ... ]}}    -> unwrapped twice
        [ { "action": "get_variables", "variables": [...] } ]  (WS echo)
    """
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except Exception:  # noqa: BLE001
            return None

    if isinstance(data, list):
        # A WS batch may wrap the payload in an action envelope.
        if data and isinstance(data[0], dict) and "variables" in data[0]:
            return extract_variables(data[0]["variables"])
        # A single action envelope inside a list.
        if data and isinstance(data[0], dict) and "data" in data[0]:
            inner = extract_variables(data[0]["data"])
            if inner is not None:
                return inner
        if all(isinstance(item, dict) for item in data):
            return data
        return None

    if isinstance(data, dict):
        for key in ("variables", "data", "result", "payload"):
            if key in data:
                inner = extract_variables(data[key])
                if inner is not None:
                    return inner
        return None

    return None


class Bridge:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.cfg = cfg
        self.running = True

        self.state_lock = threading.Lock()
        self.last_state: dict[str, str] = {}
        self.has_state = False

        self.last_post_at = 0.0
        self.last_post_ok = False

        # Throttles repeated "server unreachable" warnings so a stopped
        # receiver cannot flood journalctl.
        self.cmd_failures = 0
        self.cmd_last_error: Optional[str] = None
        self.post_failures = 0
        self.post_last_error: Optional[str] = None

        self.sync_lock = threading.Lock()
        self.sync_cond = threading.Condition()
        self.sync_pending = False
        self.sync_deadline = 0.0
        self.sync_trigger = "unknown"

        self.session = requests.Session()
        self.session.headers.update({"X-Bridge-Token": cfg["bridge_token"]})

    # ------------------------------------------------------------------ #
    # FreeShow IO
    # ------------------------------------------------------------------

    def fetch_variables(self) -> Optional[list[dict[str, Any]]]:
        """Fetch the current variables from FreeShow's HTTP API."""
        try:
            resp = self.session.post(
                self.cfg["freeshow_http_url"],
                json={"action": "get_variables"},
                timeout=6,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "FreeShow HTTP unreachable at %s (%s)%s",
                self.cfg["freeshow_http_url"],
                exc,
                _network_hint(exc),
            )
            return None

        variables = extract_variables(data)
        if variables is None:
            log.warning("Unexpected get_variables payload: %s", str(data)[:200])
            return None
        return variables

    def apply_change_variable(self, variable_id: str, value: str) -> bool:
        """Apply a variable edit to FreeShow via its HTTP API."""
        try:
            resp = self.session.post(
                self.cfg["freeshow_http_url"],
                json={
                    "action": "change_variable",
                    "id": variable_id,
                    "key": "value",
                    "value": value,
                },
                timeout=6,
            )
            ok = resp.ok
            if not ok:
                log.warning(
                    "change_variable %s failed: HTTP %s %s",
                    variable_id,
                    resp.status_code,
                    resp.text[:200],
                )
            return ok
        except Exception as exc:  # noqa: BLE001
            log.warning("change_variable %s error: %s%s", variable_id, exc, _network_hint(exc))
            return False

    # ------------------------------------------------------------------ #
    # Sync: diff FreeShow state -> POST snapshot to the server
    # ------------------------------------------------------------------

    def request_sync(self, trigger: str) -> None:
        with self.sync_cond:
            if not self.sync_pending:
                self.sync_pending = True
                self.sync_deadline = time.time() + self.cfg["debounce_seconds"]
            self.sync_trigger = trigger
            self.sync_cond.notify_all()

    def sync_worker(self) -> None:
        while self.running:
            fire_trigger: Optional[str] = None
            with self.sync_cond:
                if self.sync_pending:
                    remaining = self.sync_deadline - time.time()
                    if remaining <= 0:
                        fire_trigger = self.sync_trigger
                        self.sync_pending = False
                    else:
                        self.sync_cond.wait(timeout=min(remaining, 0.2))
                else:
                    self.sync_cond.wait(timeout=0.2)
            if fire_trigger:
                try:
                    self.do_sync(fire_trigger)
                except Exception as exc:  # noqa: BLE001
                    log.exception("Sync failed (%s): %s", fire_trigger, exc)

    def do_sync(self, trigger: str) -> None:
        with self.sync_lock:
            variables = self.fetch_variables()
            if variables is None:
                self.last_post_ok = False
                return

            new_state: dict[str, str] = {}
            changed: list[dict[str, Any]] = []
            for item in variables:
                if not isinstance(item, dict):
                    continue
                vid = str(item.get("id", ""))
                value = "" if item.get("value") is None else str(item.get("value"))
                new_state[vid] = value
                if self.has_state and vid in self.last_state and self.last_state[vid] != value:
                    changed.append(
                        {
                            "id": vid,
                            "name": item.get("name"),
                            "from": self.last_state[vid],
                            "to": value,
                        }
                    )

            with self.state_lock:
                initial = not self.has_state

            heartbeat_due = (time.time() - self.last_post_at) >= self.cfg["heartbeat_seconds"]
            if not changed and not initial and trigger not in ("startup", "heartbeat") and not heartbeat_due:
                return

            payload = {
                "variables": variables,
                "changed": changed,
                "updatedAt": _utc_now_iso(),
                "source": f"{trigger}{'/initial' if initial else ''}",
            }
            url = self.cfg["server_url"].rstrip("/") + "/api/variables"
            try:
                resp = self.session.post(
                    url,
                    json=payload,
                    timeout=10,
                )
                resp.raise_for_status()
            except Exception as exc:  # noqa: BLE001
                self.last_post_ok = False
                self.post_failures += 1
                signature = f"{type(exc).__name__}: {exc}"
                # Log the actionable detail the first time (and periodically),
                # then stay quiet so a stopped receiver cannot flood the logs.
                if signature != self.post_last_error or self.post_failures % 20 == 1:
                    log.warning(
                        "POST to server failed (%s, %d consecutive): %s%s",
                        trigger,
                        self.post_failures,
                        exc,
                        _network_hint(exc),
                    )
                else:
                    log.debug("POST to server still failing (%s): %s", trigger, exc)
                self.post_last_error = signature
                return

            self.last_post_at = time.time()
            self.last_post_ok = True
            if self.post_failures:
                log.info(
                    "Reconnected to the receiver after %d failed attempt(s).",
                    self.post_failures,
                )
            self.post_failures = 0
            self.post_last_error = None
            with self.state_lock:
                self.last_state = new_state
                self.has_state = True
            log.info(
                "Synced %d variables to server (trigger=%s, changed=%d%s)",
                len(variables),
                trigger,
                len(changed),
                ", initial" if initial else "",
            )

    # ------------------------------------------------------------------ #
    # Trigger threads: WebSocket, HTTP poll, command poller
    # ------------------------------------------------------------------

    def ws_loop(self) -> None:
        """
        Best-effort WebSocket trigger. The HTTP poller alone keeps variables in
        sync, so this only buys lower latency.
        """
        if self.cfg["ws_transport"] == "none" or not self.cfg["freeshow_ws_url"]:
            log.info(
                "WebSocket trigger disabled; relying on HTTP polling every %ss",
                self.cfg["poll_seconds"],
            )
            return

        backoff = 1.0
        short_lived = 0
        hinted = False

        while self.running:
            transport = self.cfg["ws_transport"]
            started = time.time()
            try:
                if transport == "socketio":
                    self._socketio_once()
                else:
                    self._websocket_once()
            except Exception as exc:  # noqa: BLE001
                log.warning("WS transport error (%s): %s", transport, exc)

            if not self.running:
                break

            # Only treat this as a healthy connection if it actually stayed up.
            # (A socket that closes immediately returns normally, which used to
            # reset the backoff and spam "reconnecting in 1s" forever.)
            if time.time() - started >= 30.0:
                backoff = 1.0
                short_lived = 0
            else:
                short_lived += 1
                backoff = min(backoff * 2, 30.0)
                if short_lived >= 5 and not hinted:
                    hinted = True
                    log.warning(
                        "The FreeShow WebSocket keeps closing immediately (%d attempts). "
                        "Variables still sync over HTTP every %ss, so this only costs a "
                        "little latency. If FreeShow's socket speaks Socket.IO, retry with "
                        "--ws-transport socketio; to silence these messages entirely, use "
                        "--ws-transport none.",
                        short_lived,
                        self.cfg["poll_seconds"],
                    )

            log.info("WS reconnecting in %.0fs (%s)", backoff, transport)
            deadline = time.time() + backoff
            while self.running and time.time() < deadline:
                time.sleep(0.2)

    def _websocket_once(self) -> None:
        import websocket  # websocket-client

        def on_open(_ws: Any) -> None:
            log.info("WebSocket connected to FreeShow (%s)", self.cfg["freeshow_ws_url"])
            self.request_sync("ws_connect")

        def on_message(_ws: Any, message: Any) -> None:
            text = message if isinstance(message, str) else str(message)
            if self.cfg["verbose"]:
                log.debug("WS message: %s", text[:500])
            if "variable" in text.lower():
                self.request_sync("ws_message")

        def on_error(_ws: Any, error: Any) -> None:
            if self.cfg["verbose"]:
                log.debug("WS error: %s", error)

        def on_close(_ws: Any, code: Any, msg: Any) -> None:
            log.info("WebSocket closed (code=%s)", code)

        ws_app = websocket.WebSocketApp(
            self.cfg["freeshow_ws_url"],
            on_open=on_open,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close,
        )
        ws_app.run_forever(ping_interval=20, ping_timeout=10)

    def _socketio_once(self) -> None:
        import socketio  # python-socketio

        sio = socketio.Client()

        @sio.event
        def connect() -> None:
            log.info("socket.io connected to FreeShow")
            self.request_sync("ws_connect")

        @sio.on("*")
        def any_event(event: str, *args: Any) -> None:
            text = json.dumps(args, default=str)
            if self.cfg["verbose"]:
                log.debug("socket.io %s: %s", event, text[:300])
            if "variable" in text.lower() or "variable" in event.lower():
                self.request_sync("ws_message")

        sio.connect(self.cfg["freeshow_ws_url"])
        while self.running and sio.connected:
            time.sleep(0.5)
        try:
            sio.disconnect()
        except Exception:  # noqa: BLE001
            pass

    def poll_loop(self) -> None:
        interval = self.cfg["poll_seconds"]
        while self.running:
            self.request_sync("poll")
            for _ in range(int(interval * 10)):
                if not self.running:
                    return
                time.sleep(0.1)

    def command_loop(self) -> None:
        if not self.cfg["enable_commands"]:
            log.info("Command lane disabled (ENABLE_COMMANDS=false)")
            return
        interval = self.cfg["command_poll_seconds"]
        while self.running:
            try:
                resp = self.session.get(
                    self.cfg["server_url"].rstrip("/") + "/api/commands", timeout=8
                )
                if resp.ok:
                    self.cmd_failures = 0
                    self.cmd_last_error = None
                    commands = resp.json().get("commands", [])
                    applied: list[str] = []
                    for command in commands:
                        if not self.running:
                            return
                        variable_id = str(command.get("variableId", ""))
                        value = str(command.get("value", ""))
                        if variable_id and self.apply_change_variable(variable_id, value):
                            applied.append(str(command.get("id", "")))
                            log.info(
                                "Applied command %s -> %s=%r",
                                str(command.get("id", ""))[:8],
                                variable_id,
                                value,
                            )
                        time.sleep(0.2)
                    if applied:
                        self.session.post(
                            self.cfg["server_url"].rstrip("/") + "/api/commands/ack",
                            json={"ids": applied},
                            timeout=8,
                        )
                        self.request_sync("command_applied")
            except Exception as exc:  # noqa: BLE001
                self.cmd_failures += 1
                signature = f"{type(exc).__name__}: {exc}"
                if signature != self.cmd_last_error or self.cmd_failures % 20 == 1:
                    log.warning(
                        "Command poll failed (%d consecutive): %s%s",
                        self.cmd_failures,
                        exc,
                        _network_hint(exc),
                    )
                else:
                    log.debug("Command poll still failing: %s", exc)
                self.cmd_last_error = signature
            for _ in range(int(interval * 10)):
                if not self.running:
                    return
                time.sleep(0.1)


    # Lifecycle
    # ------------------------------------------------------------------

    def stop(self, *_args: Any) -> None:
        log.info("Stopping bridge...")
        self.running = False
        with self.sync_cond:
            self.sync_cond.notify_all()

    def run(self) -> None:
        threads = [
            threading.Thread(target=self.sync_worker, name="sync", daemon=True),
            threading.Thread(target=self.poll_loop, name="poll", daemon=True),
        ]
        if self.cfg["freeshow_ws_url"] and self.cfg["ws_transport"] != "none":
            threads.append(threading.Thread(target=self.ws_loop, name="ws", daemon=True))
        else:
            log.info("WebSocket trigger disabled; relying on HTTP polling")
        if self.cfg["enable_commands"]:
            threads.append(threading.Thread(target=self.command_loop, name="commands", daemon=True))

        for thread in threads:
            thread.start()

        log.info(
            "Bridge started -> server=%s | freeshow_http=%s | ws=%s (%s) | commands=%s",
            self.cfg["server_url"],
            self.cfg["freeshow_http_url"],
            self.cfg["freeshow_ws_url"] or "off",
            self.cfg["ws_transport"],
            "on" if self.cfg["enable_commands"] else "off",
        )
        self.request_sync("startup")

        try:
            while self.running:
                time.sleep(0.5)
        except KeyboardInterrupt:
            self.stop()
        for thread in threads:
            thread.join(timeout=3)
        log.info("Bridge stopped")

def parse_args() -> dict[str, Any]:
    parser = argparse.ArgumentParser(
        description="Bridge FreeShow variables to the deployed FreeShow SMS Manager server."
    )
    parser.add_argument("--server-url", default=os.environ.get("SERVER_URL", ""),
                        help="Base URL of the deployed receiver (e.g. https://app.example.com) or env SERVER_URL")
    parser.add_argument("--bridge-token", default=os.environ.get("BRIDGE_TOKEN", ""),
                        help="Shared secret sent as X-Bridge-Token (or env BRIDGE_TOKEN)")
    parser.add_argument("--freeshow-http-url", default=os.environ.get("FREESHOW_HTTP_URL", "http://localhost:5505"),
                        help="FreeShow HTTP API base URL")
    parser.add_argument("--freeshow-ws-url", default=os.environ.get("FREESHOW_WS_URL", "ws://localhost:5505"),
                        help="FreeShow WebSocket URL (empty string disables the WS trigger)")
    parser.add_argument("--ws-transport", default=os.environ.get("WS_TRANSPORT", "websocket"),
                        choices=["websocket", "socketio", "none"],
                        help="WS transport protocol used by FreeShow (default: websocket)")
    parser.add_argument("--enable-commands", dest="enable_commands",
                        action=argparse.BooleanOptionalAction,
                        default=os.environ.get("ENABLE_COMMANDS", "true").lower() in ("1", "true", "yes"),
                        help="Poll the server for variable-edit commands (default: on)")
    parser.add_argument("--poll-seconds", type=float, default=float(os.environ.get("POLL_SECONDS", "5")),
                        help="FreeShow HTTP poll interval (default: 5)")
    parser.add_argument("--command-poll-seconds", type=float,
                        default=float(os.environ.get("COMMAND_POLL_SECONDS", "3")),
                        help="Server command poll interval (default: 3)")
    parser.add_argument("--debounce-ms", type=float, default=float(os.environ.get("DEBOUNCE_MS", "500")),
                        help="Debounce window before a sync POST (default: 500)")
    parser.add_argument("--heartbeat-seconds", type=float,
                        default=float(os.environ.get("HEARTBEAT_SECONDS", "60")),
                        help="Force a snapshot POST at least this often (default: 60)")
    parser.add_argument("--verbose", action="store_true",
                        help="Debug logging incl. raw WebSocket payloads")
    parser.add_argument("--log-level", default=os.environ.get("LOG_LEVEL", "INFO"))
    args = parser.parse_args()

    if not args.server_url:
        parser.error("--server-url (or env SERVER_URL) is required")
    if not args.bridge_token:
        log.warning("BRIDGE_TOKEN is empty; the server will reject posts if it requires a token")

    server_url = normalize_base_url(args.server_url, "SERVER_URL")
    if args.server_url.strip() != server_url:
        log.warning("Interpreted SERVER_URL %r as %s", args.server_url, server_url)

    return {
        "server_url": server_url,
        "bridge_token": args.bridge_token,
        "freeshow_http_url": normalize_base_url(args.freeshow_http_url, "FREESHOW_HTTP_URL"),
        "freeshow_ws_url": normalize_base_url(
            args.freeshow_ws_url, "FREESHOW_WS_URL", default_scheme="ws"
        ),
        "ws_transport": args.ws_transport,
        "enable_commands": args.enable_commands,
        "poll_seconds": max(args.poll_seconds, 1.0),
        "command_poll_seconds": max(args.command_poll_seconds, 1.0),
        "debounce_seconds": max(args.debounce_ms, 0) / 1000.0,
        "heartbeat_seconds": max(args.heartbeat_seconds, 5.0),
        "verbose": args.verbose,
        "log_level": args.log_level,
    }


def main() -> None:
    cfg = parse_args()
    logging.basicConfig(
        level="DEBUG" if cfg["verbose"] else cfg["log_level"].upper(),
        format="%(asctime)s %(levelname)s [%(threadName)s] %(message)s",
    )

    log.info(
        "Bridge starting\n"
        "  server (receiver)  : %s\n"
        "  bridge token       : %s\n"
        "  FreeShow HTTP      : %s\n"
        "  FreeShow WebSocket : %s (%s)\n"
        "  commands enabled   : %s\n"
        "  intervals          : poll=%ss commands=%ss heartbeat=%ss",
        cfg["server_url"],
        mask_secret(cfg["bridge_token"]),
        cfg["freeshow_http_url"],
        cfg["freeshow_ws_url"] or "(disabled)",
        cfg["ws_transport"],
        cfg["enable_commands"],
        cfg["poll_seconds"],
        cfg["command_poll_seconds"],
        cfg["heartbeat_seconds"],
    )

    bridge = Bridge(cfg)

    def handle_signal(signum: int, _frame: Any) -> None:
        log.info("Received signal %s", signum)
        bridge.stop()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    bridge.run()


if __name__ == "__main__":
    main()