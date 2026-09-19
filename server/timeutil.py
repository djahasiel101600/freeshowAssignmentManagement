"""
Time helpers shared by the receiver.

Everything is stored as ISO-8601 text so the API shape matches the frontend
types exactly (``createdAt``, ``updatedAt``, ``sentAt`` ...). Timestamps are
UTC; *calendar dates* (the day an assignment belongs to) are resolved in the
configured local timezone so a late-evening service still counts as "today".
"""

from __future__ import annotations

import os
from datetime import date, datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Calendar-day timezone. Defaults to Asia/Manila (PH church / Semaphore).
SCHEDULE_TZ_NAME = os.environ.get("SCHEDULE_TZ", "Asia/Manila").strip() or "Asia/Manila"

try:
    SCHEDULE_TZ = ZoneInfo(SCHEDULE_TZ_NAME)
except ZoneInfoNotFoundError:  # pragma: no cover - only on a broken tzdata
    SCHEDULE_TZ = timezone.utc
    SCHEDULE_TZ_NAME = "UTC"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_now_iso() -> str:
    """UTC timestamp with an explicit offset (matches the existing payloads)."""
    return utc_now().isoformat()


def local_now() -> datetime:
    return datetime.now(SCHEDULE_TZ)


def today_iso() -> str:
    """Today's calendar date (YYYY-MM-DD) in the configured local timezone."""
    return local_now().date().isoformat()


def to_iso_date(value: date | datetime | str) -> str:
    """Normalise anything date-like to a YYYY-MM-DD string."""
    if isinstance(value, str):
        return value.strip()[:10]
    if isinstance(value, datetime):
        return value.date().isoformat()
    return value.isoformat()


def parse_iso_date(value: str) -> date | None:
    try:
        return date.fromisoformat(to_iso_date(value))
    except (TypeError, ValueError):
        return None


def days_between(earlier: str, later: str) -> int | None:
    """Whole days between two YYYY-MM-DD strings (positive when later > earlier)."""
    first = parse_iso_date(earlier)
    second = parse_iso_date(later)
    if first is None or second is None:
        return None
    return (second - first).days


def week_start_iso(value: str) -> str:
    """Monday of the week containing ``value`` (used for weekly groupings)."""
    day = parse_iso_date(value)
    if day is None:
        return to_iso_date(value)
    return (day.fromordinal(day.toordinal() - day.weekday())).isoformat()


def normalize_key(value: Optional[str]) -> str:
    """
    Normalise free text for people matching.

    Lower-cases, strips punctuation/extra whitespace and removes common titles
    so that "Pastor John D." and "john d" resolve to the same key.
    """
    if not value:
        return ""
    text = str(value).strip().lower()
    # Drop titles/honorifics that FreeShow operators like to include.
    for title in (
        "pastor ", "ptr. ", "ptr ", "bro. ", "bro ", "sis. ", "sis ",
        "rev. ", "rev ", "dr. ", "dr ", "ate ", "kuya ", "tatay ",
    ):
        if text.startswith(title):
            text = text[len(title):]
    # Collapse anything that isn't a letter/digit into single spaces.
    cleaned = "".join(ch if ch.isalnum() else " " for ch in text)
    return " ".join(cleaned.split())
