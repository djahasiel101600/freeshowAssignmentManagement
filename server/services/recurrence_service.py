"""
Recurring schedules for assignment variables.

Why this module exists
----------------------
A bridge snapshot tells us *when a variable changed on screen*. Here the
operators type the coming week's assignments in on Sunday evening, so the ledger
ends up dated on the Sunday the schedule was entered - not on the Friday,
Saturday or Sunday service the assignment is actually *for*. A prediction built
from those dates can only ever answer "when you next type the schedule in".

An ``AssignmentScheduleRule`` supplies the missing calendar: which weekday(s) the
assignment is for, how often (every week, every other week, ...), one anchor
occurrence that fixes the interval's phase, and ``lead_days`` - how many days
before the service the schedule is entered.

Example::

    rule = "every Sunday, entered 1 day before"
    recorded 2026-09-20 (Sunday evening)  ->  service date 2026-09-27
    rule = "every Friday, entered 1 day before"
    recorded 2026-09-20 (Sunday evening)  ->  service date 2026-09-25

Everything here is pure date arithmetic plus rule lookups: no writes and no
request state, so the rotation analysis and the ingest path share one definition
of "which service date does this entry belong to".
"""

from __future__ import annotations

from collections import Counter
from datetime import date, timedelta
from typing import Any, Iterable, Mapping, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import AssignmentScheduleRule
from timeutil import (
    WEEKDAY_NAMES,
    local_now,
    parse_iso_date,
    to_iso_date,
)

DAYS_PER_WEEK = 7
MIN_INTERVAL_WEEKS = 1
MAX_INTERVAL_WEEKS = 12
MAX_LEAD_DAYS = 14
# Hard cap so a mis-configured rule can never spin in a loop.
MAX_LADDER_STEPS = 600
WEEKDAY_INDEX = {name.lower(): index for index, name in enumerate(WEEKDAY_NAMES)}
WEEKDAY_INDEX.update({name[:3].lower(): index for index, name in enumerate(WEEKDAY_NAMES)})


# --------------------------------------------------------------------------- #
# Rule accessors (ORM row or plain dict)
# --------------------------------------------------------------------------- #
def _pick(source: Any, *keys: str, default: Any = None) -> Any:
    """Read the first present key, so camelCase payloads and ORM rows both work."""
    if source is None:
        return default
    if isinstance(source, Mapping):
        for key in keys:
            if key in source and source[key] is not None:
                return source[key]
        return default
    for key in keys:
        if hasattr(source, key):
            value = getattr(source, key)
            if value is not None:
                return value
    return default


def weekday_index(value: Any) -> Optional[int]:
    """Accept ``6``, ``"6"``, ``"Sunday"`` or ``"sun"``."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if 0 <= value <= 6 else None
    text = str(value).strip().lower()
    if not text:
        return None
    if text.isdigit():
        number = int(text)
        return number if 0 <= number <= 6 else None
    return WEEKDAY_INDEX.get(text)


def normalize_weekdays(values: Any) -> list[int]:
    """De-duplicate and sort any iterable of weekday spellings/numbers."""
    if values is None:
        return []
    if isinstance(values, (str, int)):
        values = [values]
    found = {index for index in (weekday_index(item) for item in values) if index is not None}
    return sorted(found)


def rule_weekdays(rule: Any) -> list[int]:
    return normalize_weekdays(_pick(rule, "weekdays"))


def rule_interval_weeks(rule: Any) -> int:
    try:
        value = int(_pick(rule, "intervalWeeks", "interval_weeks", default=1) or 1)
    except (TypeError, ValueError):
        return 1
    return max(MIN_INTERVAL_WEEKS, min(MAX_INTERVAL_WEEKS, value))


def rule_lead_days(rule: Any) -> int:
    try:
        value = int(_pick(rule, "leadDays", "lead_days", default=1) or 0)
    except (TypeError, ValueError):
        return 0
    return max(0, min(MAX_LEAD_DAYS, value))


def rule_enabled(rule: Any) -> bool:
    raw = _pick(rule, "enabled", default=True)
    if raw is None:
        return True
    if isinstance(raw, str):
        return raw.strip().lower() not in {"false", "0", "no", ""}
    return bool(raw)


def interval_days(rule: Any) -> int:
    return rule_interval_weeks(rule) * DAYS_PER_WEEK


def normalize_anchor(anchor: Any, weekdays: Iterable[int], *, fallback: Optional[date] = None) -> date:
    """
    Snap an anchor forward onto a selected weekday.

    The anchor only has to be *one real occurrence*; snapping keeps the ladder
    consistent with ``weekdays`` even when the two disagree (e.g. an anchor that
    falls on a Thursday while the rule says Sunday).
    """
    days = normalize_weekdays(weekdays)
    base = parse_iso_date(anchor) if anchor else None
    if base is None:
        base = fallback or local_now().date()
    if not days:
        return base
    for _ in range(DAYS_PER_WEEK):
        if base.weekday() in days:
            return base
        base += timedelta(days=1)
    return base


def rule_anchor(rule: Any, *, weekdays: Optional[list[int]] = None, fallback: Optional[date] = None) -> date:
    days = weekdays if weekdays is not None else rule_weekdays(rule)
    return normalize_anchor(_pick(rule, "anchorDate", "anchor_date"), days, fallback=fallback)


def is_configured(rule: Any) -> bool:
    """True when a rule exists, is enabled and names at least one weekday."""
    return rule is not None and rule_enabled(rule) and bool(rule_weekdays(rule))



def _ceil_div(value: int, step: int) -> int:
    """``ceil(value / step)`` for negative values too (used to walk the ladder)."""
    return -(-value // step)


def rule_week_anchors(rule: Any, *, fallback: Optional[date] = None) -> list[date]:
    """
    One ladder anchor per selected weekday, all inside the anchor's own week.

    The stored anchor pins the *week* (its Monday); every selected weekday in
    that week is then an occurrence. That is what makes "every week on Friday,
    Saturday and Sunday" produce all three days instead of only the weekday the
    anchor happens to fall on, while a single-weekday rule is unaffected because
    its anchor *is* that weekday.
    """
    weekdays = rule_weekdays(rule)
    if not weekdays:
        return []
    base = normalize_anchor(
        _pick(rule, "anchorDate", "anchor_date"), weekdays, fallback=fallback
    )
    week_start = base - timedelta(days=base.weekday())
    return [week_start + timedelta(days=day) for day in weekdays]


# --------------------------------------------------------------------------- #
# The occurrence ladder
# --------------------------------------------------------------------------- #
def occurrence_ladder(rule: Any, start: date, end: date, *, limit: int = MAX_LADDER_STEPS) -> list[date]:
    """
    Every occurrence of the rule between ``start`` and ``end`` (inclusive).

    Each weekday has its own arithmetic progression (``anchor + k *
    interval_days``), so the result is exact: no daylight saving, month-length
    or leap-year special cases, because everything is a whole number of days.
    """
    if not is_configured(rule) or end < start:
        return []
    step = interval_days(rule)
    result: list[date] = []
    for anchor in rule_week_anchors(rule, fallback=start):
        offset = (start - anchor).days
        candidate = anchor + timedelta(days=_ceil_div(offset, step) * step)
        while candidate <= end and len(result) < limit:
            result.append(candidate)
            candidate += timedelta(days=step)
    return sorted(set(result))[:limit]


def next_occurrence(rule: Any, after: Optional[date], *, include_after: bool = True) -> Optional[date]:
    """First occurrence at/after (or strictly after) ``after``."""
    if after is None or not is_configured(rule):
        return None
    start = after if include_after else after + timedelta(days=1)
    step = interval_days(rule)
    candidates = [
        anchor + timedelta(days=_ceil_div((start - anchor).days, step) * step)
        for anchor in rule_week_anchors(rule, fallback=start)
    ]
    return min(candidates) if candidates else None


def previous_occurrence(rule: Any, before: Optional[date], *, include_before: bool = True) -> Optional[date]:
    """Last occurrence at/before (or strictly before) ``before``."""
    if before is None or not is_configured(rule):
        return None
    end = before if include_before else before - timedelta(days=1)
    step = interval_days(rule)
    candidates = [
        anchor + timedelta(days=((end - anchor).days // step) * step)  # floor
        for anchor in rule_week_anchors(rule, fallback=end)
    ]
    return max(candidates) if candidates else None


def derived_schedule_date(rule: Any, recorded: Optional[date]) -> Optional[date]:
    """
    Which service an entry *recorded on* ``recorded`` was entered for.

    The schedule is typed in ``lead_days`` before the service it covers, so the
    answer is the first occurrence on/after ``recorded + lead_days``. With the
    default ``lead_days = 1`` a Sunday-evening entry belongs to the *next*
    occurrence of the rule (next Sunday / Friday / Saturday), not to the Sunday
    it was typed on.

    With several weekdays selected the nearest upcoming occurrence wins, which
    keeps single-weekday rules (one service per variable) unambiguous.
    """
    if recorded is None or not is_configured(rule):
        return None
    target = recorded + timedelta(days=rule_lead_days(rule))
    return next_occurrence(rule, target)


def effective_date(
    recorded: Optional[date],
    schedule_date: Optional[str] = None,
    rule: Any = None,
) -> Optional[date]:
    """
    The date an assignment should be counted on.

    Resolution order: an explicitly pinned ``schedule_date`` wins, then the rule
    is applied to the recorded date, and finally the recorded date itself is used
    (the behaviour before rules existed).
    """
    pinned = parse_iso_date(schedule_date) if schedule_date else None
    if pinned is not None:
        return pinned
    derived = derived_schedule_date(rule, recorded)
    if derived is not None:
        return derived
    return recorded


def effective_date_source(schedule_date: Optional[str] = None, rule: Any = None) -> str:
    """``pinned`` | ``rule`` | ``recorded`` - so the UI can explain a date."""
    if parse_iso_date(schedule_date) if schedule_date else None:
        return "pinned"
    return "rule" if is_configured(rule) else "recorded"


# --------------------------------------------------------------------------- #
# Human-readable description
# --------------------------------------------------------------------------- #
def describe_rule(rule: Any) -> Optional[str]:
    weekdays = rule_weekdays(rule)
    if not weekdays:
        return None
    interval = rule_interval_weeks(rule)
    names = [WEEKDAY_NAMES[day] for day in weekdays]
    if len(names) == DAYS_PER_WEEK:
        return "every day" if interval == 1 else f"every day (every {interval} weeks)"
    if interval == 1 and len(names) == 1:
        return f"every {names[0]}"
    joined = names[0] if len(names) == 1 else ", ".join(names[:-1]) + f" and {names[-1]}"
    prefix = "every week" if interval == 1 else f"every {interval} weeks"
    return f"{prefix} on {joined}"


def entry_pattern(recorded_dates: Iterable[date], rule: Any = None) -> dict[str, Any]:
    """
    Compare how entries were actually *recorded* with the rule's interval.

    This is the honest fidelity check for a schedule: the service weekdays are
    true by construction once a rule exists, but a missed or late update shows up
    here as a recorded gap that does not match ``intervalWeeks * 7``.
    """
    ordered = sorted(set(recorded_dates))
    gaps = [(b - a).days for a, b in zip(ordered, ordered[1:])]
    expected = interval_days(rule) if is_configured(rule) else None
    if not gaps:
        return {
            "sampleCount": 0,
            "modalGapDays": None,
            "modeShare": None,
            "expectedGapDays": expected,
            "matchesInterval": None,
        }
    modal_gap, count = Counter(gaps).most_common(1)[0]
    return {
        "sampleCount": len(gaps),
        "modalGapDays": modal_gap,
        "modeShare": round(count / len(gaps), 3),
        "expectedGapDays": expected,
        "matchesInterval": bool(expected is not None and modal_gap == expected),
    }


# --------------------------------------------------------------------------- #
# Rule lookups (the only database-aware helpers in this module)
# --------------------------------------------------------------------------- #
def find_rule(db: Session, variable_name: str, *, enabled_only: bool = False) -> Optional[AssignmentScheduleRule]:
    """The stored rule for one variable, or ``None``."""
    if not variable_name:
        return None
    rule = db.scalar(
        select(AssignmentScheduleRule).where(
            AssignmentScheduleRule.variable_name == variable_name
        )
    )
    if rule is None:
        return None
    if enabled_only and not rule_enabled(rule):
        return None
    return rule


def rules_by_variable(db: Session, *, enabled_only: bool = True) -> dict[str, AssignmentScheduleRule]:
    """
    Every rule keyed by variable name.

    Read once per request (or per snapshot) so the analysis never issues a query
    per ledger row.
    """
    rows = db.scalars(select(AssignmentScheduleRule)).all()
    return {
        rule.variable_name: rule
        for rule in rows
        if rule.variable_name and (not enabled_only or rule_enabled(rule))
    }


# --------------------------------------------------------------------------- #
# Serialisation for the API / rotation report
# --------------------------------------------------------------------------- #
def no_schedule_payload(variable_name: Optional[str] = None) -> dict[str, Any]:
    """The ``schedule`` block for a variable that has no rule yet."""
    return {
        "configured": False,
        "variableName": variable_name,
        "label": "",
        "weekdays": [],
        "weekdayLabels": [],
        "intervalWeeks": None,
        "anchorDate": None,
        "leadDays": None,
        "enabled": False,
        "notes": "",
        "description": None,
        "nextOccurrence": None,
        "previousOccurrence": None,
        "upcoming": [],
        "source": "recorded",
    }


def schedule_payload(rule: Any, *, today: Optional[date] = None, upcoming: int = 4) -> dict[str, Any]:
    """
    Resolve a rule into the shape the app renders.

    ``upcoming`` is the number of future occurrences to include, which is what
    lets the UI show "next: Fri 25 Sep, then 2, 9 and 16 Oct" without doing any
    date maths of its own.
    """
    if not is_configured(rule):
        payload = no_schedule_payload(_pick(rule, "variableName", "variable_name"))
        if rule is not None:
            payload["enabled"] = rule_enabled(rule)
            payload["weekdays"] = rule_weekdays(rule)
            payload["weekdayLabels"] = [WEEKDAY_NAMES[day] for day in rule_weekdays(rule)]
            payload["intervalWeeks"] = rule_interval_weeks(rule)
            payload["leadDays"] = rule_lead_days(rule)
            payload["label"] = str(_pick(rule, "label", default="") or "")
        return payload

    reference = today or local_now().date()
    weekdays = rule_weekdays(rule)
    anchor = rule_anchor(rule, weekdays=weekdays, fallback=reference)
    next_date = next_occurrence(rule, reference)
    previous = previous_occurrence(rule, reference)

    ahead: list[str] = []
    cursor = next_date
    while cursor is not None and len(ahead) < max(0, upcoming):
        ahead.append(cursor.isoformat())
        cursor = next_occurrence(rule, cursor + timedelta(days=1))

    return {
        "configured": True,
        "variableName": _pick(rule, "variableName", "variable_name"),
        "label": str(_pick(rule, "label", default="") or ""),
        "weekdays": weekdays,
        "weekdayLabels": [WEEKDAY_NAMES[day] for day in weekdays],
        "intervalWeeks": rule_interval_weeks(rule),
        "anchorDate": anchor.isoformat(),
        "leadDays": rule_lead_days(rule),
        "enabled": rule_enabled(rule),
        "notes": str(_pick(rule, "notes", default="") or ""),
        "description": describe_rule(rule),
        "nextOccurrence": next_date.isoformat() if next_date else None,
        "previousOccurrence": previous.isoformat() if previous else None,
        "upcoming": ahead,
        "intervalDays": interval_days(rule),
        "source": "rule",
        "updatedAt": _pick(rule, "updatedAt", "updated_at"),
    }


# --------------------------------------------------------------------------- #
# Validation (shared by the API and any importer)
# --------------------------------------------------------------------------- #
def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() not in {"false", "0", "no", ""}
    return bool(value)


def validate_rule_payload(
    payload: Mapping[str, Any], *, variable_name: Optional[str] = None
) -> dict[str, Any]:
    """
    Normalise a request body into ORM column names.

    Raises ``ValueError`` with an operator-readable message; the router turns
    that into an HTTP 400.
    """
    if not isinstance(payload, Mapping):
        raise ValueError("Body must be a JSON object")

    name = str(_pick(payload, "variableName", "variable_name") or variable_name or "").strip()
    if not name:
        raise ValueError("'variableName' is required")
    if len(name) > 160:
        raise ValueError("'variableName' must be 160 characters or fewer")

    weekdays = normalize_weekdays(_pick(payload, "weekdays"))
    if not weekdays:
        raise ValueError("Pick at least one weekday (0=Monday ... 6=Sunday, or a weekday name)")

    interval = _as_int(_pick(payload, "intervalWeeks", "interval_weeks"), 1)
    if not MIN_INTERVAL_WEEKS <= interval <= MAX_INTERVAL_WEEKS:
        raise ValueError(
            f"'intervalWeeks' must be between {MIN_INTERVAL_WEEKS} and {MAX_INTERVAL_WEEKS}"
        )

    lead = _as_int(_pick(payload, "leadDays", "lead_days"), 1)
    if not 0 <= lead <= MAX_LEAD_DAYS:
        raise ValueError(f"'leadDays' must be between 0 and {MAX_LEAD_DAYS}")

    anchor_raw = _pick(payload, "anchorDate", "anchor_date")
    if anchor_raw in (None, ""):
        anchor = normalize_anchor(None, weekdays)
    else:
        parsed = parse_iso_date(to_iso_date(str(anchor_raw)))
        if parsed is None:
            raise ValueError("'anchorDate' must be a YYYY-MM-DD date")
        anchor = normalize_anchor(parsed, weekdays)

    return {
        "variable_name": name,
        "label": str(_pick(payload, "label", default="") or "").strip()[:200],
        "weekdays": weekdays,
        "interval_weeks": interval,
        "anchor_date": anchor.isoformat(),
        "lead_days": lead,
        "enabled": _as_bool(_pick(payload, "enabled"), True),
        "notes": str(_pick(payload, "notes", default="") or "").strip()[:500],
    }
