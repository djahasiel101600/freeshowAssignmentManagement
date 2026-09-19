"""
Authentication + user administration.

The browser signs in once with a username/password and receives an HttpOnly
session cookie; every other endpoint then depends on ``current_user``. The
legacy ``X-App-Token`` machine credential keeps working (see ``security.py``),
so the bridge and any existing scripts are unaffected.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from db import get_db
from models import User
from security import (
    SESSION_COOKIE,
    SESSION_COOKIE_SECURE,
    SESSION_TTL_HOURS,
    client_token,
    create_session,
    current_user,
    ensure_bootstrap_admin,
    hash_password,
    password_problem,
    require_admin,
    revoke_session,
    revoke_user_sessions,
    verify_password,
)
from timeutil import utc_now_iso

log = logging.getLogger("freeshow.auth.api")

router = APIRouter(prefix="/api", tags=["auth"])


# --------------------------------------------------------------------------- #
# Payloads
# --------------------------------------------------------------------------- #
class LoginPayload(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class PasswordChangePayload(BaseModel):
    currentPassword: str = ""
    newPassword: str = Field(min_length=8, max_length=256)


class UserCreatePayload(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=8, max_length=256)
    displayName: str = ""
    role: str = "user"


class UserUpdatePayload(BaseModel):
    displayName: Optional[str] = None
    role: Optional[str] = None
    isActive: Optional[bool] = None
    password: Optional[str] = None


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=SESSION_TTL_HOURS * 3600,
        httponly=True,
        samesite="lax",
        secure=SESSION_COOKIE_SECURE,
        path="/",
    )


# --------------------------------------------------------------------------- #
# Session lifecycle
# --------------------------------------------------------------------------- #
@router.get("/auth/bootstrap")
def bootstrap_state(db: Session = Depends(get_db)) -> dict[str, Any]:
    """
    Public probe used by the login screen.

    Reports whether any account exists yet, so a fresh install can explain how
    to create the first admin instead of showing a form nobody can submit.
    """
    any_user = db.scalar(select(User.id).limit(1))
    if any_user is None:
        # Running the bootstrap here means a container started without
        # ADMIN_PASSWORD still produces an admin (password logged once).
        ensure_bootstrap_admin(db)
        any_user = db.scalar(select(User.id).limit(1))
    return {"ok": True, "hasUsers": any_user is not None, "requiresLogin": True}


@router.post("/auth/login")
def login(
    payload: LoginPayload,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    username = payload.username.strip()
    user = db.scalar(select(User).where(User.username == username))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="This account is disabled")

    token, session = create_session(
        db, user, user_agent=request.headers.get("user-agent", "")
    )
    _set_session_cookie(response, token)
    log.info("Login: %s", user.username)
    return {"ok": True, "user": user.to_dict(), "expiresAt": session.expires_at}


@router.post("/auth/logout")
def logout(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    revoke_session(db, client_token(request))
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/auth/me")
def whoami(user: User = Depends(current_user)) -> dict[str, Any]:
    return {"ok": True, "user": user.to_dict(), "isMachine": user.username == "machine"}


@router.post("/auth/password")
def change_password(
    payload: PasswordChangePayload,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    """Change your own password (machine access must use an admin instead)."""
    if user.username == "machine":
        raise HTTPException(status_code=403, detail="Machine access cannot change passwords")
    if not verify_password(payload.currentPassword, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    problem = password_problem(payload.newPassword)
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    user.password_hash = hash_password(payload.newPassword)
    user.updated_at = utc_now_iso()
    db.commit()
    # Keep the caller signed in, drop every other device.
    revoke_user_sessions(db, user.id, keep_token=client_token(request))
# --------------------------------------------------------------------------- #
# User administration (admin only)
# --------------------------------------------------------------------------- #
@router.get("/users")
def list_users(
    db: Session = Depends(get_db), _: User = Depends(require_admin)
) -> dict[str, Any]:
    users = db.scalars(select(User).order_by(User.username)).all()
    return {"users": [user.to_dict() for user in users]}


@router.post("/users", status_code=201)
def create_user(
    payload: UserCreatePayload,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    username = payload.username.strip()
    if db.scalar(select(User).where(User.username == username)):
        raise HTTPException(status_code=409, detail="That username is already taken")
    problem = password_problem(payload.password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    user = User(
        username=username,
        display_name=(payload.displayName or username).strip(),
        password_hash=hash_password(payload.password),
        role="admin" if payload.role == "admin" else "user",
        is_active=True,
    )
    db.add(user)
    db.commit()
    log.info("User %r created by %s", user.username, admin.username)
    return {"ok": True, "user": user.to_dict()}


@router.patch("/users/{user_id}")
def update_user(
    user_id: str,
    payload: UserUpdatePayload,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    if payload.displayName is not None:
        user.display_name = payload.displayName.strip()
    if payload.role is not None:
        if user.id == admin.id and payload.role != "admin":
            raise HTTPException(status_code=400, detail="You cannot demote yourself")
        user.role = "admin" if payload.role == "admin" else "user"
    if payload.isActive is not None:
        if user.id == admin.id and not payload.isActive:
            raise HTTPException(status_code=400, detail="You cannot disable yourself")
        user.is_active = payload.isActive
        if not payload.isActive:
            revoke_user_sessions(db, user.id)
    if payload.password is not None:
        problem = password_problem(payload.password)
        if problem:
            raise HTTPException(status_code=400, detail=problem)
        user.password_hash = hash_password(payload.password)
        revoke_user_sessions(db, user.id)

    user.updated_at = utc_now_iso()
    db.commit()
    return {"ok": True, "user": user.to_dict()}


@router.delete("/users/{user_id}")
def delete_user(
    user_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    if user.username == "machine":
        raise HTTPException(status_code=400, detail="The machine account is required")

    db.delete(user)
    db.commit()
    log.info("User %r deleted by %s", user.username, admin.username)
    return {"ok": True}


@router.get("/sessions")
def list_sessions(
    db: Session = Depends(get_db), _: User = Depends(require_admin)
) -> dict[str, Any]:
    """Active sessions, useful for auditing who is signed in where."""
    from models import AuthSession

    sessions = db.scalars(
        select(AuthSession)
        .where(AuthSession.revoked.is_(False))
        .order_by(AuthSession.last_seen_at.desc())
    ).all()
    usernames = {user.id: user.username for user in db.scalars(select(User)).all()}
    return {
        "sessions": [
            {
                "id": session.id,
                "username": usernames.get(session.user_id, "?"),
                "createdAt": session.created_at,
                "lastSeenAt": session.last_seen_at,
                "expiresAt": session.expires_at,
                "userAgent": session.user_agent,
            }
            for session in sessions
        ]
    }
    return {"ok": True}