"""
Authentication and session helpers.

Design notes
------------
* **No extra dependencies.** Password hashing is PBKDF2-HMAC-SHA256 from the
  stdlib (``hashlib.pbkdf2_hmac``) with a per-user salt and a tunable iteration
  count. Session tokens are ``secrets.token_urlsafe`` values, and only their
  SHA-256 digest is stored, so a database leak does not hand out live sessions.
* **Sessions are server-side rows** (``auth_sessions``), not JWTs, so logout /
  user deactivation / password change can revoke access immediately.
* The browser authenticates with an **HttpOnly cookie** (``fsms_session``,
  ``SameSite=Lax``). Non-browser callers may instead send
  ``Authorization: Bearer <token>``.
* The legacy machine credential (``X-App-Token``) keeps working for the
  bridge/automation paths so nothing that already works breaks.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
from datetime import timedelta
from typing import Optional

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from db import get_db
from models import AuthSession, User
from timeutil import utc_now, utc_now_iso

log = logging.getLogger("freeshow.auth")

SESSION_COOKIE = os.environ.get("SESSION_COOKIE_NAME", "fsms_session").strip() or "fsms_session"
SESSION_TTL_HOURS = int(os.environ.get("SESSION_TTL_HOURS", "720"))  # 30 days
SESSION_COOKIE_SECURE = os.environ.get("SESSION_COOKIE_SECURE", "").strip().lower() in {"1", "true", "yes"}
PBKDF2_ITERATIONS = int(os.environ.get("PBKDF2_ITERATIONS", "240000"))

# Machine credential used by the bridge/scripts (pre-existing behaviour).
APP_TOKEN = os.environ.get("APP_TOKEN", "").strip()


# --------------------------------------------------------------------------- #
# Passwords
# --------------------------------------------------------------------------- #
def hash_password(password: str) -> str:
    """Return ``pbkdf2_sha256$<iterations>$<salt-hex>$<digest-hex>``."""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time verification of a stored PBKDF2 hash."""
    try:
        algorithm, iterations, salt_hex, digest_hex = stored.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        expected = bytes.fromhex(digest_hex)
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
        )
    except (ValueError, AttributeError):
        return False
    return hmac.compare_digest(candidate, expected)


def password_problem(password: str) -> Optional[str]:
    """Return a human-readable complaint, or ``None`` when the password is OK."""
    if len(password or "") < 8:
        return "Password must be at least 8 characters long."
    return None


# --------------------------------------------------------------------------- #
# Session tokens
# --------------------------------------------------------------------------- #
def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(db: Session, user: User, user_agent: str = "") -> tuple[str, AuthSession]:
    token = new_token()
    session = AuthSession(
        user_id=user.id,
        token_hash=hash_token(token),
        expires_at=(utc_now() + timedelta(hours=SESSION_TTL_HOURS)).isoformat(),
        user_agent=(user_agent or "")[:255],
    )
    db.add(session)
    user.last_login_at = utc_now_iso()
    user.updated_at = utc_now_iso()
    db.commit()
    return token, session


def resolve_session(db: Session, token: str) -> Optional[tuple[User, AuthSession]]:
    """Look up a live session by raw token, refreshing ``last_seen_at``."""
    if not token:
        return None
    session = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
    if session is None or session.revoked:
        return None
    if session.expires_at <= utc_now_iso():
        return None
    user = db.get(User, session.user_id)
    if user is None or not user.is_active:
        return None
    session.last_seen_at = utc_now_iso()
    db.commit()
    return user, session


def revoke_session(db: Session, token: str) -> bool:
    session = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
    if session is None:
        return False
    session.revoked = True
    db.commit()
    return True


def revoke_user_sessions(db: Session, user_id: str, keep_token: Optional[str] = None) -> int:
    """Revoke every session for a user (optionally sparing the current one)."""
    keep_hash = hash_token(keep_token) if keep_token else None
    sessions = db.scalars(
        select(AuthSession).where(AuthSession.user_id == user_id, AuthSession.revoked.is_(False))
    ).all()
    revoked = 0
    for session in sessions:
        if keep_hash and session.token_hash == keep_hash:
            continue
        session.revoked = True
        revoked += 1
    db.commit()
    return revoked


def purge_expired_sessions(db: Session) -> int:
    now = utc_now_iso()
    sessions = db.scalars(select(AuthSession).where(AuthSession.expires_at <= now)).all()
    for session in sessions:
        db.delete(session)
    if sessions:
        db.commit()
    return len(sessions)



# --------------------------------------------------------------------------- #
# Bootstrap
# --------------------------------------------------------------------------- #
def ensure_bootstrap_admin(db: Session) -> Optional[str]:
    """
    Guarantee at least one admin exists.

    With ``ADMIN_USERNAME``/``ADMIN_PASSWORD`` set in the environment the first
    startup creates that account (or repairs its password when
    ``ADMIN_PASSWORD_RESET=true``). Otherwise a random password is generated
    and logged **once** so the operator can sign in and change it.
    """
    username = (os.environ.get("ADMIN_USERNAME", "admin") or "admin").strip() or "admin"
    password = (os.environ.get("ADMIN_PASSWORD", "") or "").strip()
    reset = (os.environ.get("ADMIN_PASSWORD_RESET", "") or "").strip().lower() in {"1", "true", "yes"}

    admin = db.scalar(select(User).where(User.username == username))
    generated: Optional[str] = None

    if admin is None:
        if not password:
            password = secrets.token_urlsafe(12)
            generated = password
        admin = User(
            username=username,
            display_name="Administrator",
            password_hash=hash_password(password),
            role="admin",
            is_active=True,
        )
        db.add(admin)
        db.commit()
        log.info("Created bootstrap admin %r", username)
    elif password and reset:
        admin.password_hash = hash_password(password)
        admin.updated_at = utc_now_iso()
        db.commit()
        log.info("Reset password for %r", username)

    return generated


# --------------------------------------------------------------------------- #
# FastAPI dependencies
# --------------------------------------------------------------------------- #
def _bearer_token(request: Request) -> str:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return ""


def client_token(request: Request) -> str:
    """Session token from the cookie, falling back to a Bearer header."""
    return request.cookies.get(SESSION_COOKIE) or _bearer_token(request)


def optional_user(request: Request, db: Session = Depends(get_db)) -> Optional[User]:
    """Resolve the signed-in user, or ``None`` for anonymous callers."""
    resolved = resolve_session(db, client_token(request))
    return resolved[0] if resolved else None


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """
    Require an authenticated caller.

    Accepts a browser session **or** the legacy ``X-App-Token`` machine
    credential (used by scripts/bridge and by the pre-login frontend), so
    existing automation keeps working after the upgrade.
    """
    resolved = resolve_session(db, client_token(request))
    if resolved:
        return resolved[0]

    supplied = (request.headers.get("x-app-token") or "").strip()
    if APP_TOKEN and supplied and hmac.compare_digest(supplied, APP_TOKEN):
        return machine_user(db)

    raise HTTPException(status_code=401, detail="Authentication required")


def require_admin(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Administrator access required")
    return user


def machine_user(db: Session) -> User:
    """Stable synthetic identity representing app-token/machine access."""
    machine = db.scalar(select(User).where(User.username == "machine"))
    if machine is None:
        machine = User(
            username="machine",
            display_name="Bridge / automation",
            # Unusable password: this account is only reachable via APP_TOKEN.
            password_hash="pbkdf2_sha256$0$00$00",
            role="user",
            is_active=True,
        )
        db.add(machine)
        db.commit()
    return machine
