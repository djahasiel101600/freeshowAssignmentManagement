"""
Rotation / recurrence analysis over the assignment ledger.

Answers the questions that motivated the database in the first place:

* **Is there a cycle?** — gap statistics between one person's turns, the modal
  gap, its consistency, and the weekday distribution.
* **What is the rotation order?** — the sequence of people in first-appearance
  order, plus whether the sequence repeats cleanly.
* **Who is next (and when)?** — predicted date + predicted person.
* **Who was assigned previously?** — per-person totals and last dates.

All functions are pure reads: they never mutate the ledger.
"""

from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from datetime import date, timedelta
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Assignment, AssignmentChange
from timeutil import parse_iso_date, today_iso

WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


# --------------------------------------------------------------------------- #
# Ledger reads
# --------------------------------------------------------------------------- #
def list_assignments(
    db: Session,
    *,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    variable_name: Optional[str] = None,
    person: Optional[str] = None,
    limit: int = 500,
) -> list[Assignment]:
    query = select(Assignment).order_by(Assignment.assignment_date.desc(), Assignment.variable_name)
    if date_from:
        query = query.where(Assignment.assignment_date >= date_from)
    if date_to:
        query = query.where(Assignment.assignment_date <= date_to)
    if variable_name:
        query = query.where(Assignment.variable_name == variable_name)
    if person:
        needle = f"%{person.lower()}%"
        query = query.where(
            (Assignment.contact_name.ilike(needle)) | (Assignment.value.ilike(needle))
        )
    return list(db.scalars(query.limit(max(1, min(limit, 5000)))).all())


def list_changes(
    db: Session,
    *,
    variable_name: Optional[str] = None,
    person: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: int = 200,
) -> list[AssignmentChange]:
    query = select(AssignmentChange).order_by(AssignmentChange.changed_at.desc())
    if variable_name:
        query = query.where(AssignmentChange.variable_name == variable_name)
    if person:
        needle = f"%{person.lower()}%"
        query = query.where(
            (AssignmentChange.new_contact_name.ilike(needle))
            | (AssignmentChange.previous_contact_name.ilike(needle))
            | (AssignmentChange.new_value.ilike(needle))
        )
    if date_from:
        query = query.where(AssignmentChange.assignment_date >= date_from)
    if date_to:
        query = query.where(AssignmentChange.assignment_date <= date_to)
    return list(db.scalars(query.limit(max(1, min(limit, 2000)))).all())


def tracked_variable_names(db: Session) -> list[str]:
    rows = db.scalars(
        select(Assignment.variable_name).distinct().order_by(Assignment.variable_name)
    ).all()
    return [name for name in rows if name]


# --------------------------------------------------------------------------- #
# Interval helpers
# --------------------------------------------------------------------------- #
def _gaps(dates: list[date]) -> list[int]:
    """Day gaps between consecutive dates (sorted ascending)."""
    ordered = sorted(set(dates))
    return [(b - a).days for a, b in zip(ordered, ordered[1:])]


def _summarize_gaps(gaps: list[int]) -> dict[str, Any]:
    if not gaps:
        return {
            "sampleCount": 0,
            "min": None,
            "max": None,
            "median": None,
            "mean": None,
            "modalGap": None,
            "modeShare": None,
            "stdev": None,
            "consistent": False,
        }
    counts = Counter(gaps)
    modal_gap, modal_count = counts.most_common(1)[0]
    stdev = round(statistics.pstdev(gaps), 2) if len(gaps) > 1 else 0.0
    return {
        "sampleCount": len(gaps),
        "min": min(gaps),
        "max": max(gaps),
        "median": statistics.median(gaps),
        "mean": round(statistics.fmean(gaps), 2),
        "modalGap": modal_gap,
        "modeShare": round(modal_count / len(gaps), 3),
        "stdev": stdev,
        # "Consistent" = the most common spacing covers most turns and the
        # spread is small. That is what a real rotation looks like.
        "consistent": bool(modal_count / len(gaps) >= 0.6 and (stdev <= 2 or modal_count >= 3)),
    }


def _predict_next(dates: list[date], modal_gap: Optional[int]) -> Optional[str]:
    if not dates or not modal_gap:
        return None
    last = max(dates)
    today = parse_iso_date(today_iso()) or last
    candidate = last + timedelta(days=modal_gap)
    # Roll forward until the prediction is in the future.
    while candidate <= today:
        candidate += timedelta(days=modal_gap)
    return candidate.isoformat()


# --------------------------------------------------------------------------- #
# Analysis
# --------------------------------------------------------------------------- #
def analyze_variable(
    db: Session, variable_name: str, *, lookback_days: int = 730
) -> dict[str, Any]:
    """Full recurrence report for one assignment variable."""
    cutoff = None
    today = parse_iso_date(today_iso())
    if today is not None and lookback_days > 0:
        cutoff = (today - timedelta(days=lookback_days)).isoformat()

    query = select(Assignment).where(Assignment.variable_name == variable_name)
    if cutoff:
        query = query.where(Assignment.assignment_date >= cutoff)
    rows = list(db.scalars(query.order_by(Assignment.assignment_date)).all())

    # --- per person ------------------------------------------------------- #
    person_dates: dict[str, list[date]] = defaultdict(list)
    person_contacts: dict[str, Optional[str]] = {}
    for row in rows:
        label = (row.contact_name or row.value or "").strip()
        if not label:
            continue
        when = parse_iso_date(row.assignment_date)
        if when is None:
            continue
        person_dates[label].append(when)
        person_contacts.setdefault(label, row.contact_id)

    people: list[dict[str, Any]] = []
    for label, dates in person_dates.items():
        gaps = _gaps(dates)
        summary = _summarize_gaps(gaps)
        last = max(dates)
        people.append(
            {
                "name": label,
                "contactId": person_contacts.get(label),
                "turnCount": len(dates),
                "firstAssigned": min(dates).isoformat(),
                "lastAssigned": last.isoformat(),
                "daysSinceLast": (today - last).days if today else None,
                "gapDays": summary["median"],
                "modalGapDays": summary["modalGap"],
                "predictedNextDate": _predict_next(dates, summary["modalGap"]),
                "weekdays": sorted({WEEKDAY_NAMES[d.weekday()] for d in dates}),
                **{f"interval{k[0].upper()}{k[1:]}": v for k, v in summary.items()},
            }
        )
    people.sort(key=lambda item: (-item["turnCount"], item["name"]))

    # --- rotation order / cycle ------------------------------------------ #
    order: list[str] = []
    seq: list[str] = []
    for row in rows:
        label = (row.contact_name or row.value or "").strip()
        if not label:
            continue
        seq.append(label)
        if label not in order:
            order.append(label)

    period = len(order)
    sequence_repeats = False
    repeat_accuracy: Optional[float] = None
    if period >= 2 and len(seq) >= period * 2:
        expected = [order[i % period] for i in range(len(seq))]
        hits = sum(1 for actual, want in zip(seq, expected) if actual == want)
        repeat_accuracy = round(hits / len(seq), 3)
        sequence_repeats = repeat_accuracy >= 0.75

    all_dates = [parse_iso_date(row.assignment_date) for row in rows]
    all_dates = [d for d in all_dates if d is not None]
    cycle_gaps = _summarize_gaps(_gaps(all_dates))

    weekday_counts: Counter[int] = Counter()
    for row in rows:
        when = parse_iso_date(row.assignment_date)
        if when is not None:
            weekday_counts[when.weekday()] += 1
    dominant_weekday = None
    if weekday_counts:
        day_index, count = weekday_counts.most_common(1)[0]
        dominant_weekday = {
            "weekday": WEEKDAY_NAMES[day_index],
            "share": round(count / sum(weekday_counts.values()), 3),
        }

    next_person: Optional[dict[str, Any]] = None
    if order:
        last_row = rows[-1] if rows else None
        last_person = (last_row.contact_name or last_row.value or "").strip() if last_row else ""
        upcoming = [p for p in people if p["predictedNextDate"]]
        if upcoming:
            upcoming.sort(key=lambda item: item["predictedNextDate"])
            next_person = upcoming[0]
        elif sequence_repeats and last_person in order:
            next_person = {"name": order[(order.index(last_person) + 1) % period], "basis": "rotation-order"}

    return {
        "variableName": variable_name,
        "hasData": bool(rows),
        "totalAssignments": len(rows),
        "distinctPeople": period,
        "firstDate": min(all_dates).isoformat() if all_dates else None,
        "lastDate": max(all_dates).isoformat() if all_dates else None,
        "lookbackDays": lookback_days,
        "people": people,
        "rotationOrder": order,
        "cycle": {
            "periodDays": cycle_gaps["modalGap"],
            "periodLabel": _label_gap(cycle_gaps["modalGap"]),
            "consistency": cycle_gaps["modeShare"],
            "isRegular": cycle_gaps["consistent"],
            "sequenceRepeats": sequence_repeats,
            "sequenceAccuracy": repeat_accuracy,
            "rotationLength": period,
            **{f"gap{k[0].upper()}{k[1:]}": v for k, v in cycle_gaps.items()},
        },
        "dominantWeekday": dominant_weekday,
        "nextExpected": next_person,
    }


def _label_gap(gap: Optional[int]) -> Optional[str]:
    if not gap:
        return None
    if gap % 7 == 0 and gap >= 7:
        weeks = gap // 7
        return "weekly" if weeks == 1 else f"every {weeks} weeks"
    if gap == 1:
        return "daily"
    if gap == 2:
        return "every other day"
    if 27 <= gap <= 32:
        return "monthly"
    return f"every {gap} days"