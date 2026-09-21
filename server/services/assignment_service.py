"""
Assignment recording — the durable "who was assigned when" ledger.

Every snapshot the bridge pushes is inspected for *person-assignment*
variables (see ``settings_service.tracking_config``). For each match we:

1. **upsert an** ``Assignment`` **row** for today's calendar date, and
2. **append an** ``AssignmentChange`` **row** whenever the value actually
   changed.

That gives two complementary views:

* ``assignments`` — one row per day/variable: "who was on duty on 2026-09-14".
* ``assignment_changes`` — an append-only audit trail: "when did it change,
  from whom to whom, and what caused it".

Nothing here is destructive: a value that reverts later keeps both changes, so
the history can never be rewritten by a later edit.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Iterable, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Assignment, AssignmentChange, Contact
from timeutil import local_now, normalize_key, to_iso_date, today_iso, utc_now_iso

log = logging.getLogger("freeshow.assignments")

# Value separators used when several people share one variable
# e.g. "John D. / Mary S." or "Usher 1, Usher 2".
_SPLIT_RE = re.compile(r"\s*(?:/|,|;|\||\+|&|\band\b)\s*", re.IGNORECASE)


# --------------------------------------------------------------------------- #
# People matching
# --------------------------------------------------------------------------- #
def build_contact_index(db: Session) -> dict[str, Contact]:
    """
    Map every normalised contact name / nickname -> Contact.

    The first spelling wins, so a contact's real name is always preferred over
    a nickname that another contact also happens to use.
    """
    index: dict[str, Contact] = {}
    for contact in db.scalars(select(Contact)).all():
        for candidate in [contact.name, *(contact.nicknames or [])]:
            key = normalize_key(candidate)
            if key:
                index.setdefault(key, contact)
    return index


def split_people(value: str) -> list[str]:
    """Split a free-text value into individual people (best effort)."""
    if not value:
        return []
    parts = [part.strip() for part in _SPLIT_RE.split(value) if part and part.strip()]
    # If splitting produced nothing useful keep the raw value as one person.
    return parts or [value.strip()]


def match_contact(
    value: str, index: dict[str, Contact], exact_first: bool = True
) -> Optional[Contact]:
    """
    Resolve a free-text assignment value to a contact.

    Tries the whole value, then each split part, then a *contains* fallback so
    that "Sis. Mary (Worship)" still finds Mary.
    """
    if not value:
        return None
    key = normalize_key(value)
    if key and key in index:
        return index[key]
    for part in split_people(value):
        part_key = normalize_key(part)
        if part_key and part_key in index:
            return index[part_key]
    if exact_first:
        return None
    for name, contact in index.items():
        if name and name in key:
            return contact
    return None


def is_assignment_variable(
    name: str, value: str, tracking: dict[str, Any], index: dict[str, Contact]
) -> bool:
    """Decide whether a FreeShow variable represents a person assignment."""
    if not name:
        return False

    allow_list = [str(item) for item in (tracking.get("variableNames") or [])]
    if allow_list:
        lowered = {item.strip().lower() for item in allow_list if str(item).strip()}
        if name.strip().lower() not in lowered:
            return False
        return True

    lowered_name = name.strip().lower()
    patterns = [str(p).strip().lower() for p in (tracking.get("patterns") or []) if str(p).strip()]
    if any(pattern in lowered_name for pattern in patterns):
        return True

    if tracking.get("matchContacts", True) and value:
        return match_contact(value, index) is not None

    return False


# --------------------------------------------------------------------------- #
# Recording
# --------------------------------------------------------------------------- #
def _describe(value: str, index: dict[str, Contact]) -> tuple[Optional[str], str, str]:
    """Return ``(contact_id, contact_name, phone)`` for an assignment value."""
    contact = match_contact(value, index)
    if contact is not None:
        return contact.id, contact.name, contact.phone_number or ""
    # No contact row: keep the raw text as the person's name so history is
    # still meaningful for people who were never added to the contact list.
    return None, (value or "").strip(), ""


def record_variable_change(
    db: Session,
    *,
    variable_id: str,
    variable_name: str,
    new_value: str,
    previous_value: str = "",
    source: str = "bridge",
    trigger: str = "",
    assignment_date: Optional[str] = None,
    schedule_date: Optional[str] = None,
    note: str = "",
    user_id: Optional[str] = None,
    index: Optional[dict[str, Contact]] = None,
    commit: bool = True,
) -> Optional[Assignment]:
    """
    Upsert the assignment for one variable/date and log the change.

    ``assignment_date`` is the day the change was *recorded*; ``schedule_date``
    optionally pins the *service* it belongs to (manual entry or a backfill).
    Bridge snapshots leave it empty on purpose, so the recurring schedule rule
    keeps deciding the service date at read time - retuning a rule then also
    corrects how past entries are interpreted.

    Returns the ``Assignment`` row, or ``None`` when nothing was recorded.
    """
    when = assignment_date or today_iso()
    pinned = to_iso_date(schedule_date) if schedule_date else None
    if index is None:
        index = build_contact_index(db)

    contact_id, contact_name, phone = _describe(new_value, index)
    now = utc_now_iso()

    row = db.scalar(
        select(Assignment).where(
            Assignment.assignment_date == when,
            Assignment.variable_id == variable_id,
        )
    )
    created = row is None
    if row is None:
        row = Assignment(
            assignment_date=when,
            schedule_date=pinned,
            variable_id=variable_id,
            variable_name=variable_name,
            value=new_value,
            contact_id=contact_id,
            contact_name=contact_name,
            contact_phone=phone,
            source=source,
            note=note,
            first_seen_at=now,
            updated_at=now,
            updated_by=user_id,
        )
        db.add(row)
    else:
        row.value = new_value
        row.variable_name = variable_name or row.variable_name
        row.contact_id = contact_id
        row.contact_name = contact_name
        row.contact_phone = phone
        row.source = source
        # An explicit service date wins; a snapshot (pinned=None) never clears a
        # date a person pinned, it just leaves the rule in charge.
        if pinned:
            row.schedule_date = pinned
        if note:
            row.note = note
        row.updated_at = now
        row.updated_by = user_id

    # Only log a *change* when the value really moved (or the day's row is new
    # and already carries a value). This keeps the audit trail signal-rich.
    if created or (previous_value or "") != (new_value or ""):
        _, prev_name, _ = _describe(previous_value, index)
        db.add(
            AssignmentChange(
                assignment_id=row.id,
                assignment_date=when,
                variable_id=variable_id,
                variable_name=variable_name,
                previous_value=previous_value or "",
                new_value=new_value or "",
                previous_contact_name=prev_name,
                new_contact_name=contact_name,
                new_contact_id=contact_id,
                source=source,
                trigger=trigger or "",
                note=note,
                changed_at=now,
                user_id=user_id,
            )
        )

    if commit:
        db.commit()
    return row
def record_snapshot(
    db: Session,
    *,
    variables: Iterable[dict[str, Any]],
    changed: Iterable[dict[str, Any]],
    source: str,
    tracking: dict[str, Any],
    trigger: str = "",
    user_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Ingest one bridge snapshot.

    ``changed`` is what the bridge already diffed for us; we additionally look
    up the stored assignment for today so the audit trail has the previous
    value even right after a receiver restart (when the bridge re-sends
    everything as an "initial" snapshot).
    """
    changed_by_id: dict[str, dict[str, Any]] = {}
    for item in changed or []:
        if isinstance(item, dict) and item.get("id"):
            changed_by_id[str(item["id"])] = item

    index = build_contact_index(db)
    when = today_iso()
    now = utc_now_iso()
    tracked = 0
    logged = 0

    # Existing rows for today, fetched once (avoids a query per variable).
    existing_rows = {
        row.variable_id: row
        for row in db.scalars(select(Assignment).where(Assignment.assignment_date == when)).all()
    }
    already_logged = {
        change.variable_id
        for change in db.scalars(
            select(AssignmentChange).where(AssignmentChange.assignment_date == when)
        ).all()
    }

    for variable in variables or []:
        if not isinstance(variable, dict):
            continue
        variable_id = str(variable.get("id") or "")
        variable_name = str(variable.get("name") or "")
        if not variable_id or not variable_name:
            continue
        value = "" if variable.get("value") is None else str(variable.get("value"))
        if not is_assignment_variable(variable_name, value, tracking, index):
            continue

        entry = changed_by_id.get(variable_id)
        existing = existing_rows.get(variable_id)

        if entry is not None:
            previous = str(entry.get("previous") or entry.get("oldValue") or "")
        elif existing is not None:
            previous = existing.value or ""
        else:
            # Nothing stored for today and the bridge saw no diff: this is the
            # first snapshot of the day, so treat "unknown" as an empty start
            # rather than inventing a change against yesterday's value.
            previous = ""

        row_is_new = existing is None
        if row_is_new and not value:
            # An empty value on a brand-new day carries no information.
            continue
        if not row_is_new and entry is None and previous == value:
            continue

        record_variable_change(
            db,
            variable_id=variable_id,
            variable_name=variable_name,
            new_value=value,
            previous_value=previous,
            source="bridge",
            trigger=source or trigger,
            assignment_date=when,
            index=index,
            commit=False,
        )
        tracked += 1
        if variable_id not in already_logged:
            already_logged.add(variable_id)
            logged += 1

    if tracked:
        db.commit()
        log.info(
            "Assignments recorded: %d tracked (%d change(s)) on %s (trigger=%s)",
            tracked,
            logged,
            when,
            source or trigger,
        )

    return {
        "date": when,
        "tracked": tracked,
        "changes": logged,
        "recordedAt": now,
    }


def note_local_day() -> str:
    """Expose the local calendar date used for assignment rows (for the UI)."""
    return local_now().date().isoformat()