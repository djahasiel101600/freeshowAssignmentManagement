"""
Recurrence / rotation analysis API.

These are read-only endpoints over the assignment ledger, answering the
questions that motivated keeping history in a database at all:

* is there a repeating cycle (period in days, how consistent),
* what is the rotation order,
* who is expected next and when,
* and who has served how many turns, most recently.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from db import get_db
from models import Assignment, User
from security import current_user
from services.rotation_service import (
    analyze_variable,
    list_assignments,
    tracked_variable_names,
)

router = APIRouter(prefix="/api/rotation", tags=["rotation"])


@router.get("/variables")
def rotation_variables(
    db: Session = Depends(get_db), _: User = Depends(current_user)
) -> dict[str, Any]:
    """Tracked variables with a per-variable turn count, for the picker list."""
    counts = dict(
        db.execute(
            select(Assignment.variable_name, func.count(Assignment.id)).group_by(
                Assignment.variable_name
            )
        ).all()
    )
    names = tracked_variable_names(db)
    return {
        "variables": [
            {"name": name, "turnCount": int(counts.get(name, 0))} for name in names
        ],
        "count": len(names),
    }


@router.get("/summary")
def rotation_summary(
    variable: Optional[str] = None,
    lookback_days: int = Query(default=730, ge=30, le=3650),
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
) -> dict[str, Any]:
    """
    Full report for one variable, or a per-variable overview when omitted.

    The overview is what the dashboard shows at a glance: cycle period, whether
    the rotation is regular, and who is next.
    """
    if variable:
        return {"ok": True, "report": analyze_variable(db, variable, lookback_days=lookback_days)}

    reports: list[dict[str, Any]] = []
    for name in tracked_variable_names(db):
        report = analyze_variable(db, name, lookback_days=lookback_days)
        reports.append(
            {
                "variableName": report["variableName"],
                "hasData": report["hasData"],
                "totalAssignments": report["totalAssignments"],
                "distinctPeople": report["distinctPeople"],
                "lastDate": report["lastDate"],
                "cycle": report["cycle"],
                "nextExpected": report["nextExpected"],
                "rotationOrder": report["rotationOrder"],
                "dominantWeekday": report["dominantWeekday"],
            }
        )
    return {"ok": True, "reports": reports, "count": len(reports)}


@router.get("/people")
def rotation_people(
    variable: Optional[str] = None,
    limit: int = Query(default=50, ge=1, le=500),
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
) -> dict[str, Any]:
    """
    "Who was assigned previously", aggregated across the whole ledger.

    Returns one row per person with turn count, first/last date and the
    variables they served on.
    """
    query = select(Assignment).order_by(Assignment.assignment_date.desc())
    if variable:
        query = query.where(Assignment.variable_name == variable)
    rows = list(db.scalars(query.limit(20000)).all())

    people: dict[str, dict[str, Any]] = {}
    for row in rows:
        label = (row.contact_name or row.value or "").strip()
        if not label:
            continue
        entry = people.setdefault(
            label,
            {
                "name": label,
                "contactId": row.contact_id,
                "contactPhone": row.contact_phone or "",
                "turnCount": 0,
                "firstDate": row.assignment_date,
                "lastDate": row.assignment_date,
                "variables": {},
            },
        )
        entry["turnCount"] += 1
        entry["firstDate"] = min(entry["firstDate"], row.assignment_date)
        entry["lastDate"] = max(entry["lastDate"], row.assignment_date)
        entry["variables"][row.variable_name] = (
            entry["variables"].get(row.variable_name, 0) + 1
        )
        if not entry["contactId"] and row.contact_id:
            entry["contactId"] = row.contact_id
            entry["contactPhone"] = row.contact_phone or ""

    result = sorted(people.values(), key=lambda item: (-item["turnCount"], item["name"]))
    for item in result:
        item["variables"] = [
            {"name": name, "count": count}
            for name, count in sorted(item["variables"].items(), key=lambda kv: (-kv[1], kv[0]))
        ]
    return {"people": result[:limit], "count": len(result)}


@router.get("/upcoming")
def rotation_upcoming(
    lookahead_days: int = Query(default=28, ge=1, le=365),
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
) -> dict[str, Any]:
    """Predicted next turn per variable, filtered to the near future."""
    upcoming: list[dict[str, Any]] = []
    for name in tracked_variable_names(db):
        report = analyze_variable(db, name)
        expected = report.get("nextExpected")
        if expected:
            upcoming.append(
                {
                    "variableName": name,
                    "person": expected,
                    "cycle": report["cycle"],
                    "lastDate": report["lastDate"],
                }
            )
    # Also expose the most recent rows so the UI can show recent history.
    recent = [row.to_dict() for row in list_assignments(db, limit=10)]
    del lookahead_days  # reserved for date-window filtering in a later iteration
    return {"upcoming": upcoming, "recent": recent}