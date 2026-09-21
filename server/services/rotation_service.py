"""
Rotation / recurrence analysis over the assignment ledger.

Answers the questions that motivated the database in the first place:

* **Is there a cycle?** — gap statistics between one person's turns, the modal
  gap, its consistency, and the weekday distribution.
* **What is the rotation order?** — the sequence of people in first-appearance
  order, plus whether the sequence repeats cleanly.
* **Who is next (and when)?** — predicted date + predicted person.

Every date here is an *effective* (service) date, not the day the bridge
happened to see the change: when a variable has a recurring schedule rule
(``services.recurrence_service``), each recorded row is mapped onto the service
it was entered for. That is what makes "next" land on a Friday/Saturday/Sunday
instead of on the evening the schedule was typed in. Rows with no rule keep
behaving exactly as before (recorded date = effective date).

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
from services import recurrence_service
from timeutil import WEEKDAY_NAMES, parse_iso_date, today_iso


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


def _next_service_date(rule: Any, last_date: Optional[date], today: date) -> Optional[str]:
    """
    The next occurrence of a schedule rule, strictly after the last one recorded.

    Walking the rule's own ladder (rather than counting from today) keeps the
    answer on the configured weekday even for a stale ledger: a weekly Sunday
    rule whose last entry is 2026-08-30 still predicts 2026-09-27.
    """
    if not recurrence_service.is_configured(rule):
        return None
    step = recurrence_service.interval_days(rule)
    candidate = (
        recurrence_service.next_occurrence(rule, last_date, include_after=False)
        if last_date is not None
        else None
    )
    if candidate is None:
        candidate = recurrence_service.next_occurrence(rule, today)
    if candidate is None:
        return None
    guard = 0
    while candidate <= today and guard < recurrence_service.MAX_LADDER_STEPS:
        candidate += timedelta(days=step)
        guard += 1
    return candidate.isoformat()


def _is_overdue(person: dict[str, Any]) -> bool:
    """True when someone is already past the gap they usually wait between turns."""
    since = person.get("daysSinceLast")
    gap = person.get("gapDays") or person.get("modalGapDays")
    if since is None or not gap:
        return False
    return since >= gap


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

    rule = recurrence_service.find_rule(db, variable_name, enabled_only=True)

    query = select(Assignment).where(Assignment.variable_name == variable_name)
    if cutoff:
        query = query.where(Assignment.assignment_date >= cutoff)
    rows = list(db.scalars(query.order_by(Assignment.assignment_date)).all())

    # --- recorded date -> service date ------------------------------------ #
    # Every row is an *observation* ("the bridge saw this value change on day
    # X"). With a schedule rule the observation is mapped onto the service it
    # was entered for, which is what makes the rest of this function predict the
    # right weekday; without a rule the recorded date is used, exactly as before.
    recorded_dates: list[date] = []
    effective_rows: dict[date, Assignment] = {}
    for row in rows:
        recorded = parse_iso_date(row.assignment_date)
        if recorded is None:
            continue
        recorded_dates.append(recorded)
        effective = recurrence_service.effective_date(recorded, row.schedule_date, rule)
        if effective is None:
            continue
        # Several observations can map onto one service (e.g. a correction the
        # next day); the later observation wins so a turn is never counted twice.
        effective_rows[effective] = row
    series: list[tuple[date, Assignment]] = sorted(effective_rows.items())
    all_dates = [when for when, _ in series]

    # --- per person ------------------------------------------------------- #
    person_dates: dict[str, list[date]] = defaultdict(list)
    person_contacts: dict[str, Optional[str]] = {}
    for when, row in series:
        label = (row.contact_name or row.value or "").strip()
        if not label:
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
    for _, row in series:
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

    cycle_gaps = _summarize_gaps(_gaps(all_dates))

    # Two different weekday questions, and they are both useful:
    #  * service weekday - the day the assignment is *for* (rule-based).
    #  * entry weekday   - the day the operator types it in (raw observations).
    dominant_weekday = _dominant_weekday(Counter(when.weekday() for when in all_dates))
    entry_weekday = _dominant_weekday(Counter(when.weekday() for when in recorded_dates))

    # --- the recurring schedule (the calendar foundation) ------------------ #
    schedule = (
        recurrence_service.schedule_payload(rule, today=today, upcoming=4)
        if rule is not None
        else recurrence_service.no_schedule_payload(variable_name)
    )
    schedule["lastServiceDate"] = all_dates[-1].isoformat() if all_dates else None
    schedule["entryPattern"] = recurrence_service.entry_pattern(recorded_dates, rule)
    # The last few recorded->service mappings, so a wrong "entered N days
    # before" offset is visible at a glance in the UI instead of silently
    # shifting every prediction.
    schedule["recentMappings"] = [
        {
            "recorded": row.assignment_date,
            "serviceDate": when.isoformat(),
            "person": (row.contact_name or row.value or "").strip(),
        }
        for when, row in series[-3:]
    ]

    last_service = all_dates[-1] if all_dates else None
    schedule_next = _next_service_date(rule, last_service, today) if today else None

    # --- who is next ------------------------------------------------------- #
    next_person: Optional[dict[str, Any]] = None
    if order:
        last_person = (
            (series[-1][1].contact_name or series[-1][1].value or "").strip() if series else ""
        )
        by_name = {person["name"]: person for person in people}
        # Fewest turns first, then the longest wait, then rotation position:
        # with an even rotation everyone has the same turn count and the longest
        # wait is exactly the person who is due.
        due = sorted(
            people,
            key=lambda person: (
                person["turnCount"],
                -(person["daysSinceLast"] or 0),
                order.index(person["name"]) if person["name"] in order else period,
            ),
        )
        due_name = due[0]["name"] if due else None
        order_name = (
            order[(order.index(last_person) + 1) % period]
            if sequence_repeats and last_person in order
            else None
        )
        candidate: Optional[str]
        basis: str
        if order_name and order_name == due_name:
            candidate, basis = order_name, "rotation-order+turn-count"
        elif order_name and not _is_overdue(by_name.get(due_name, {})):
            # The declared order still holds and nobody is overdue yet.
            candidate, basis = order_name, "rotation-order"
        elif due_name:
            candidate, basis = due_name, "fewest-turns"
        else:
            candidate, basis = order_name, "rotation-order"
        if candidate:
            turnaround = by_name.get(candidate, {})
            next_person = {
                "name": candidate,
                "basis": basis,
                "predictedNextDate": schedule_next or turnaround.get("predictedNextDate"),
                "scheduleDate": schedule_next,
                "personPredictedDate": turnaround.get("predictedNextDate"),
                "confidence": (
                    repeat_accuracy
                    if basis.startswith("rotation-order") and repeat_accuracy is not None
                    else cycle_gaps["modeShare"]
                ),
            }

    return {
        "variableName": variable_name,
        "hasData": bool(rows),
        "totalAssignments": len(series),
        "recordedAssignments": len(rows),
        "distinctPeople": period,
        "firstDate": all_dates[0].isoformat() if all_dates else None,
        "lastDate": all_dates[-1].isoformat() if all_dates else None,
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
        "schedule": schedule,
        "dominantWeekday": dominant_weekday,
        "entryWeekday": entry_weekday,
        "nextExpected": next_person,
    }


def _dominant_weekday(counts: Counter[int]) -> Optional[dict[str, Any]]:
    """Most common weekday in a counter of ``date.weekday()`` values."""
    if not counts:
        return None
    day_index, count = counts.most_common(1)[0]
    return {
        "weekday": WEEKDAY_NAMES[day_index],
        "weekdayIndex": day_index,
        "share": round(count / sum(counts.values()), 3),
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