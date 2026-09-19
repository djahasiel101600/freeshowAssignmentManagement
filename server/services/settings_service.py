"""
Typed access to the ``app_settings`` key/value table.

Everything the UI used to keep in ``localStorage`` (Semaphore key, webhook
config, composer draft, assignment-tracking rules) lives here so that settings
follow the *account* instead of the browser.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import AppSetting
from timeutil import utc_now_iso

log = logging.getLogger("freeshow.settings")

# --------------------------------------------------------------------------- #
# Known keys and their defaults
# --------------------------------------------------------------------------- #
# Which FreeShow variable *names* are treated as person assignments.
# Deliberately person-oriented: a generic word like "song" would drag
# song_title / song_key into the rotation ledger, which is not about people.
# Operators who use different naming override this in Settings -> Tracking.
DEFAULT_PATTERNS = [
    "assign",
    "personnel",
    "speaker",
    "preacher",
    "preach",
    "worship_leader",
    "song_leader",
    "usher",
    "duty",
    "sched",          # schedule / scheduled
    "serving",
    "host",
]

DEFAULTS: dict[str, Any] = {
    # Which FreeShow variables represent a *person assignment*.
    "assignment_tracking": {
        "variableNames": [],          # explicit allow-list (exact names)
        "patterns": DEFAULT_PATTERNS,  # case-insensitive substrings
        "matchContacts": True,         # also track values matching a contact/nickname
    },
    "semaphore": {"apiKey": "", "senderName": "ChurchName"},
    "webhook": {
        "url": "",
        "enabled": False,
        "retryCount": 3,
        "retryDelay": 1000,
        "includeAllVariables": True,
        "batchUpdates": False,
        "batchWindow": 2000,
    },
    # Unsaved composer working state (message text, title/value pairs, the
    # template being edited). Kept server-side so a half-written message follows
    # the account instead of a single browser profile.
    "composer_draft": {"messageTemplate": "", "variableTitlePairs": [], "templateId": None},
    # Global header/footer wrapped around every built message.
    "message_layout": {"header": "", "footer": ""},
    # Saved variable-groups layout (the Variables Manager). Stored as the list
    # the frontend sends (array of {id,name,variableIds,expanded}).
    "variable_groups": [],
}


def _default_for(key: str) -> Any:
    value = DEFAULTS.get(key)
    # Deep-ish copy so callers can't mutate the module-level default. Lists
    # matter too: `variable_groups` defaults to [] and a caller that appends to
    # what it got back would otherwise pollute the default for the process.
    if isinstance(value, dict):
        return {k: (list(v) if isinstance(v, list) else v) for k, v in value.items()}
    if isinstance(value, list):
        return list(value)
    return value


def get_setting(db: Session, key: str, default: Any = None) -> Any:
    row = db.scalar(select(AppSetting).where(AppSetting.key == key))
    if row is None:
        return _default_for(key) if default is None else default
    value = row.value
    if value is None:
        return _default_for(key) if default is None else default
    # Merge dict defaults so newly added fields appear for old rows.
    base = _default_for(key)
    if isinstance(base, dict) and isinstance(value, dict):
        merged = dict(base)
        merged.update(value)
        return merged
    return value


def set_setting(db: Session, key: str, value: Any, user_id: Optional[str] = None) -> Any:
    row = db.scalar(select(AppSetting).where(AppSetting.key == key))
    if row is None:
        row = AppSetting(key=key, value=value)
        db.add(row)
    else:
        row.value = value
    row.updated_at = utc_now_iso()
    row.updated_by = user_id
    db.commit()
    return row.value or value


def all_settings(db: Session) -> dict[str, Any]:
    """Return every known key with defaults applied (used by GET /api/settings)."""
    stored = {row.key: row.value for row in db.scalars(select(AppSetting)).all()}
    result: dict[str, Any] = {}
    for key in DEFAULTS:
        value = stored.get(key)
        base = _default_for(key)
        if isinstance(base, dict) and isinstance(value, dict):
            merged = dict(base)
            merged.update(value)
            result[key] = merged
        else:
            result[key] = value if value is not None else base
    for key, value in stored.items():
        if key not in result:
            result[key] = value
    return result


def delete_setting(db: Session, key: str) -> bool:
    row = db.scalar(select(AppSetting).where(AppSetting.key == key))
    if row is None:
        return False
    db.delete(row)
    db.commit()
    return True


def tracking_config(db: Session) -> dict[str, Any]:
    return get_setting(db, "assignment_tracking") or _default_for("assignment_tracking")