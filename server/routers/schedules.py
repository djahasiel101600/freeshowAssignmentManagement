"""
Recurring-schedule API.

The rotation analysis can answer "who is next, and when" only if it knows which
day each assignment is *for*. The bridge cannot know that (it only sees a
variable change), so the operator declares it once per variable:

    PUT /api/schedules/01_sunday_devotional
    {"weekdays": [6], "intervalWeeks": 1, "anchorDate": "2026-09-27", "leadDays": 1}

Everything downstream - the ledger's service dates, the rotation report and the
upcoming list - derives from those rules, so there is exactly one place to fix
when a schedule changes.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from db import get_db
from models import Assignment, AssignmentScheduleRule, User
from security import current_user
from services import recurrence_service
from timeutil import local_now, parse_iso_date, utc_now_iso

log = logging.getLogger("freeshow.schedules.api")

router = APIRouter(prefix="/api/schedules", tags=["schedules"])

PREVIEW_LIMIT = 25


def _serialize(
    rule: AssignmentScheduleRule, db: Session, *, today=None, upcoming: int = 4
) -> dict[str, Any]:
    """A rule plus its resolved calendar, in the shape the app renders."""
    payload = recurrence_service.schedule_payload(rule, today=today, upcoming=upcoming)
    payload["rowCount"] = int(
        db.scalar(
            select(func.count(Assignment.id)).where(
                Assignment.variable_name == rule.variable_name
            )
        )
        or 0
    )
    return payload


def _user_id(user: User) -> Optional[str]:
    return None if user.username == "machine" else user.id


@router.get("")
def list_schedules(
    db: Session = Depends(get_db), _: User = Depends(current_user)
) -> dict[str, Any]:
    """Every declared recurring schedule, with its next few occurrence dates."""
    today = local_now().date()
    rows = list(
        db.scalars(
            select(AssignmentScheduleRule).order_by(AssignmentScheduleRule.variable_name)
        ).all()
    )
    return {
        "schedules": [_serialize(rule, db, today=today) for rule in rows],
        "count": len(rows),
        "today": today.isoformat(),
    }


@router.get("/{variable_name}")
def get_schedule(
    variable_name: str,
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
) -> dict[str, Any]:
    rule = recurrence_service.find_rule(db, variable_name)
    if rule is None:
        raise HTTPException(status_code=404, detail=f"No schedule rule for '{variable_name}'")
    return {"schedule": _serialize(rule, db)}


@router.put("/{variable_name}")
async def upsert_schedule(
    variable_name: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    """
    Create or replace the recurring schedule for one variable.

    The path variable always decides which rule is written, so a rename in the
    body can never silently create a second one.
    """
    try:
        payload = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Body must be valid JSON") from exc
    try:
        fields = recurrence_service.validate_rule_payload(payload, variable_name=variable_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    fields["variable_name"] = variable_name

    rule = recurrence_service.find_rule(db, variable_name)
    created = rule is None
    if rule is None:
        rule = AssignmentScheduleRule(variable_name=variable_name, created_by=_user_id(user))
        db.add(rule)
    for key, value in fields.items():
        setattr(rule, key, value)
    rule.updated_at = utc_now_iso()
    db.commit()

    log.info(
        "Schedule rule %s for %s: %s",
        "created" if created else "updated",
        variable_name,
        recurrence_service.describe_rule(rule),
    )
    return {"ok": True, "created": created, "item": _serialize(rule, db)}


@router.delete("/{variable_name}")
def delete_schedule(
    variable_name: str,
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
) -> dict[str, Any]:
    """Drop a rule. The ledger is untouched - dates fall back to recorded days."""
    rule = recurrence_service.find_rule(db, variable_name)
    if rule is None:
        raise HTTPException(status_code=404, detail=f"No schedule rule for '{variable_name}'")
    db.delete(rule)
    db.commit()
    log.info("Schedule rule removed for %s", variable_name)
    return {"ok": True, "removed": variable_name}


@router.post("/backfill")
async def backfill_schedules(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    """
    Materialise the rule-derived service dates onto the ledger.

    Bridge rows deliberately store no ``schedule_date`` so the rule stays in
    charge of the interpretation; this action freezes the *current* reading,
    which is useful before exporting or before a rule is retuned. It never
    touches values, and it does not append to the change trail (nothing about
    who was assigned changed) - only the row's ``updated_at``/``updated_by``.

    Body: ``{"variable": "optional-name", "dryRun": true}``
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - an empty body means "all variables, apply"
        body = {}
    if body is None:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object")

    dry_run = bool(body.get("dryRun"))
    wanted = str(body.get("variable") or "").strip()

    rules = recurrence_service.rules_by_variable(db)
    if wanted:
        if wanted not in rules:
            raise HTTPException(status_code=404, detail=f"No enabled schedule rule for '{wanted}'")
        rules = {wanted: rules[wanted]}

    applied = 0
    unchanged = 0
    skipped = 0
    preview: list[dict[str, Any]] = []

    for name, rule in rules.items():
        rows = list(
            db.scalars(
                select(Assignment)
                .where(Assignment.variable_name == name)
                .order_by(Assignment.assignment_date)
            ).all()
        )
        for row in rows:
            derived = recurrence_service.derived_schedule_date(
                rule, parse_iso_date(row.assignment_date)
            )
            if derived is None:
                skipped += 1
                continue
            target = derived.isoformat()
            if row.schedule_date == target:
                unchanged += 1
                continue
            if len(preview) < PREVIEW_LIMIT:
                preview.append(
                    {
                        "variableName": name,
                        "recordedDate": row.assignment_date,
                        "scheduleDate": target,
                        "previousScheduleDate": row.schedule_date,
                        "person": row.contact_name or row.value or "",
                    }
                )
            if not dry_run:
                row.schedule_date = target
                row.updated_at = utc_now_iso()
                row.updated_by = _user_id(user)
            applied += 1

    if not dry_run and applied:
        db.commit()
        log.info("Schedule backfill applied to %d ledger row(s) by %s", applied, user.username)

    return {
        "ok": True,
        "dryRun": dry_run,
        "variables": sorted(rules),
        "applied": applied,
        "unchanged": unchanged,
        "skipped": skipped,
        "preview": preview,
        "truncated": applied > len(preview),
    }
