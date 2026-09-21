"""
Assignment ledger API.

Read endpoints answer "who was assigned when"; the write endpoints let an
operator correct the ledger by hand (``source="manual"``) when a schedule was
planned outside FreeShow. Every manual edit is appended to the change trail, so
the history stays auditable rather than silently rewritten.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from db import get_db
from models import Assignment, AssignmentChange, User
from security import current_user
from services import recurrence_service
from services.assignment_service import record_variable_change
from services.rotation_service import (
    list_assignments,
    list_changes,
    tracked_variable_names,
)
from timeutil import parse_iso_date, to_iso_date, today_iso

log = logging.getLogger("freeshow.assignments.api")

router = APIRouter(prefix="/api", tags=["assignments"])


class AssignmentPayload(BaseModel):
    date: Optional[str] = None            # YYYY-MM-DD, the day it was recorded
    scheduleDate: Optional[str] = None    # YYYY-MM-DD, the service it is for
    variableId: str = Field(min_length=1, max_length=64)
    variableName: str = Field(min_length=1, max_length=160)
    value: str = ""
    note: str = ""


def _with_service_date(row: Assignment, rule: Any) -> dict[str, Any]:
    """
    Add the resolved service date to a ledger row.

    ``scheduleDate`` is what is stored (NULL for bridge rows), ``effectiveDate``
    is what the analysis counts the row on, and ``scheduleSource`` says why -
    so the ledger can show "recorded 2026-09-20 · for 2026-09-27 (every Sunday)".
    """
    item = row.to_dict()
    recorded = parse_iso_date(row.assignment_date)
    effective = recurrence_service.effective_date(recorded, row.schedule_date, rule)
    item["effectiveDate"] = effective.isoformat() if effective else row.assignment_date
    item["scheduleSource"] = recurrence_service.effective_date_source(row.schedule_date, rule)
    item["scheduleDescription"] = recurrence_service.describe_rule(rule)
    return item


@router.get("/assignments")
def get_assignments(
    date_from: Optional[str] = Query(default=None, alias="from"),
    date_to: Optional[str] = Query(default=None, alias="to"),
    variable: Optional[str] = None,
    person: Optional[str] = None,
    limit: int = Query(default=500, ge=1, le=5000),
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
) -> dict[str, Any]:
    rows = list_assignments(
        db,
        date_from=to_iso_date(date_from) if date_from else None,
        date_to=to_iso_date(date_to) if date_to else None,
        variable_name=variable,
        person=person,
        limit=limit,
    )
    # One rule lookup for the whole page, so each row can report the service
    # date it is counted on.
    rules = recurrence_service.rules_by_variable(db)
    items = [_with_service_date(row, rules.get(row.variable_name)) for row in rows]
    return {"assignments": items, "count": len(items), "today": today_iso()}


@router.get("/assignments/changes")
def get_assignment_changes(
    variable: Optional[str] = None,
    person: Optional[str] = None,
    date_from: Optional[str] = Query(default=None, alias="from"),
    date_to: Optional[str] = Query(default=None, alias="to"),
    limit: int = Query(default=200, ge=1, le=2000),
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
) -> dict[str, Any]:
    rows = list_changes(
        db,
        variable_name=variable,
        person=person,
        date_from=to_iso_date(date_from) if date_from else None,
        date_to=to_iso_date(date_to) if date_to else None,
        limit=limit,
    )
    items = [row.to_dict() for row in rows]
    return {"changes": items, "count": len(items)}


@router.get("/assignments/variables")
def get_assignment_variables(
    db: Session = Depends(get_db), _: User = Depends(current_user)
) -> dict[str, Any]:
    names = tracked_variable_names(db)
    return {"variables": names, "count": len(names)}


@router.post("/assignments", status_code=201)
def upsert_assignment(
    payload: AssignmentPayload,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    """Record (or correct) an assignment by hand."""
    when = to_iso_date(payload.date) if payload.date else today_iso()
    existing = db.scalar(
        select(Assignment).where(
            Assignment.assignment_date == when,
            Assignment.variable_id == payload.variableId,
        )
    )
    previous = existing.value if existing is not None else ""

    rule = recurrence_service.find_rule(db, payload.variableName) if payload.variableName else None
    row = record_variable_change(
        db,
        variable_id=payload.variableId,
        variable_name=payload.variableName,
        new_value=payload.value,
        previous_value=previous,
        source="manual",
        trigger="manual-edit",
        assignment_date=when,
        schedule_date=payload.scheduleDate,
        note=payload.note,
        user_id=None if user.username == "machine" else user.id,
    )
    if row is None:
        raise HTTPException(status_code=400, detail="Nothing to record")
    return {"ok": True, "item": _with_service_date(row, rule)}


@router.delete("/assignments/{assignment_id}")
def delete_assignment(
    assignment_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
) -> dict[str, Any]:
    row = db.get(Assignment, assignment_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    # Keep the audit trail but unlink it so the ledger can be rebuilt by hand.
    for change in db.scalars(
        select(AssignmentChange).where(AssignmentChange.assignment_id == assignment_id)
    ).all():
        change.assignment_id = None
    db.delete(row)
    db.commit()
    return {"ok": True}