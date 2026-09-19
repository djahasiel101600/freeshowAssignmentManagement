"""
Settings + backup API.

Settings used to live in the browser (``localStorage``), which meant the
Semaphore key and the webhook config had to be re-entered on every device. They
now live in ``app_settings`` so they follow the account. The backup endpoints
expose the same JSON bundle the old Data Manager exported, so existing backup
files still import — they are simply applied to the database instead of the
browser.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from db import get_db
from models import (
    AppSetting,
    Assignment,
    ConditionalRule,
    Contact,
    MessageLog,
    Template,
    User,
)
from security import current_user
from services import settings_service
from services.settings_service import all_settings, delete_setting, get_setting, set_setting
from timeutil import utc_now_iso

log = logging.getLogger("freeshow.settings.api")

router = APIRouter(prefix="/api", tags=["settings"])

BUNDLE_APP = "freeshow-sms-manager"
BUNDLE_VERSION = 1

# Bundle section -> ORM model (settings handled separately as a key/value map).
SECTION_MODELS: dict[str, Any] = {
    "contacts": Contact,
    "templates": Template,
    "rules": ConditionalRule,
    "logs": MessageLog,
    "assignments": Assignment,
}

# Fields that must not be copied blindly from an imported bundle.
SKIP_FIELDS = {"user_id", "created_by", "updated_by", "updated_at", "created_at"}


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #
@router.get("/settings")
def read_settings(
    db: Session = Depends(get_db), _: User = Depends(current_user)
) -> dict[str, Any]:
    return {"settings": all_settings(db), "defaults": settings_service.DEFAULTS}


# NOTE: the /settings/tracking routes are declared *before* the parameterised
# /settings/{key} routes on purpose — FastAPI matches in declaration order, and
# otherwise "tracking" would be swallowed as a {key} named "tracking".
@router.get("/settings/tracking")
def read_tracking(
    db: Session = Depends(get_db), _: User = Depends(current_user)
) -> dict[str, Any]:
    """Which variables are treated as person assignments (rotation inputs)."""
    return {"tracking": settings_service.tracking_config(db)}


@router.put("/settings/tracking")
async def write_tracking(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object")
    value = payload.get("tracking") if "tracking" in payload else payload
    stored = set_setting(
        db,
        "assignment_tracking",
        value,
        user_id=None if user.username == "machine" else user.id,
    )
    return {"ok": True, "key": "assignment_tracking", "value": stored}


@router.put("/settings/{key}")
async def write_setting(
    key: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    """Store one setting. Body may be the raw value or ``{"value": ...}``."""
    payload = await request.json()
    value = payload.get("value") if isinstance(payload, dict) and "value" in payload else payload
    stored = set_setting(
        db, key, value, user_id=None if user.username == "machine" else user.id
    )
    return {"ok": True, "key": key, "value": stored}


@router.post("/settings")
async def write_settings(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    """Bulk update: ``{"settings": {"semaphore": {...}, ...}}``."""
    payload = await request.json()
    incoming = payload.get("settings") if isinstance(payload, dict) else None
    if not isinstance(incoming, dict):
        raise HTTPException(status_code=400, detail="'settings' must be an object")
    user_id = None if user.username == "machine" else user.id
    for key, value in incoming.items():
        set_setting(db, str(key), value, user_id=user_id)
    return {"ok": True, "settings": all_settings(db)}


@router.delete("/settings/{key}")
def remove_setting(
    key: str, db: Session = Depends(get_db), _: User = Depends(current_user)
) -> dict[str, Any]:
    removed = delete_setting(db, key)
    if not removed:
        raise HTTPException(status_code=404, detail="Setting not found")
    return {"ok": True, "settings": all_settings(db)}


# --------------------------------------------------------------------------- #
# Backup bundle (server-side equivalent of the old Data Manager)
# --------------------------------------------------------------------------- #
def _column_map(model: Any) -> dict[str, str]:
    """camelCase payload key -> ORM attribute (derived from ``to_dict``)."""
    sample = model.__table__.columns.keys()
    mapping: dict[str, str] = {}
    for column in sample:
        if column in SKIP_FIELDS:
            continue
        head, *rest = column.split("_")
        camel = head + "".join(part.capitalize() for part in rest)
        mapping[camel] = column
        mapping[column] = column
    mapping["date"] = "assignment_date"
    return mapping


def model_to_payload(row: Any) -> dict[str, Any]:
    """Serialise a row using the same camelCase shape the frontend types use."""
    return row.to_dict() if hasattr(row, "to_dict") else {}


@router.get("/backup")
def export_backup(
    db: Session = Depends(get_db), _: User = Depends(current_user)
) -> dict[str, Any]:
    """Everything, in one JSON document (downloadable from the Data tab)."""
    sections: dict[str, Any] = {}
    for name, model in SECTION_MODELS.items():
        rows = db.scalars(select(model)).all()
        sections[name] = [model_to_payload(row) for row in rows]
    sections["settings"] = {
        row.key: row.value for row in db.scalars(select(AppSetting)).all()
    }
    return {
        "app": BUNDLE_APP,
        "version": BUNDLE_VERSION,
        "exportedAt": utc_now_iso(),
        "sections": sections,
    }


@router.post("/backup")
async def import_backup(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    """
    Restore a bundle. Sections that are present *replace* the stored rows;
    omitted sections are left alone, so importing one category is possible.
    """
    payload = await request.json()
    if not isinstance(payload, dict) or not isinstance(payload.get("sections"), dict):
        raise HTTPException(status_code=400, detail="Not a backup bundle ('sections' missing)")

    sections: dict[str, Any] = payload["sections"]
    user_id = None if user.username == "machine" else user.id
    applied: dict[str, int] = {}

    for name, model in SECTION_MODELS.items():
        rows = sections.get(name)
        if not isinstance(rows, list):
            continue
        # Clear the section, then insert the file's rows verbatim.
        for existing in db.scalars(select(model)).all():
            db.delete(existing)
        db.flush()

        column_map = _column_map(model)
        inserted = 0
        for entry in rows:
            if not isinstance(entry, dict):
                continue
            kwargs: dict[str, Any] = {}
            for key, value in entry.items():
                attr = column_map.get(str(key))
                if attr and attr not in SKIP_FIELDS:
                    kwargs[attr] = value
            if "id" not in kwargs:
                kwargs["id"] = None  # let the model generate one
            try:
                row = model(**{k: v for k, v in kwargs.items() if v is not None})
            except TypeError:
                continue
            if hasattr(row, "user_id"):
                row.user_id = user_id
            if hasattr(row, "created_by"):
                row.created_by = user_id
            db.add(row)
            inserted += 1
        applied[name] = inserted

    stored_settings = sections.get("settings")
    if isinstance(stored_settings, dict):
        for key, value in stored_settings.items():
            set_setting(db, str(key), value, user_id=user_id)
        applied["settings"] = len(stored_settings)

    db.commit()
    log.info("Backup imported by %s: %s", user.username, applied)
    return {"ok": True, "applied": applied}
    return {"ok": True, "tracking": stored}