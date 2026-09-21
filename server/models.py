"""
ORM models.

Conventions
-----------
* Primary keys are 32-char hex UUIDs (``uuid4().hex``) as TEXT, which also lets
  us preserve the ids the browser generated (e.g. ``Date.now().toString()``)
  when migrating existing localStorage data.
* Timestamps are ISO-8601 UTC *strings* and every model exposes a
  ``to_dict()`` that emits exactly the camelCase shape the React app expects,
  so the frontend types did not have to change.
* Calendar dates (``Assignment.assignment_date``) are local YYYY-MM-DD strings,
  which makes range filtering a simple lexicographic comparison in SQLite.
"""

from __future__ import annotations

import uuid
from typing import Any, Optional

from sqlalchemy import (
    JSON,
    Boolean,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db import Base
from timeutil import WEEKDAY_NAMES, utc_now_iso


def new_id() -> str:
    return uuid.uuid4().hex


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(120), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    # "admin" can manage users; "user" can use the app.
    role: Mapped[str] = mapped_column(String(16), default="user")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    updated_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    last_login_at: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)

    sessions: Mapped[list["AuthSession"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "username": self.username,
            "displayName": self.display_name or self.username,
            "role": self.role,
            "isActive": bool(self.is_active),
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "lastLoginAt": self.last_login_at,
        }


class AuthSession(Base):
    """Opaque server-side session. Only the SHA-256 of the token is stored."""

    __tablename__ = "auth_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    expires_at: Mapped[str] = mapped_column(String(40), index=True)
    last_seen_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    user_agent: Mapped[str] = mapped_column(String(255), default="")
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)

    user: Mapped[User] = relationship(back_populates="sessions")


class Contact(Base):
    __tablename__ = "contacts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), index=True)
    phone_number: Mapped[str] = mapped_column(String(32), index=True)
    nicknames: Mapped[list[str]] = mapped_column(JSON, default=list)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    updated_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    created_by: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "phoneNumber": self.phone_number,
            "nicknames": self.nicknames or [],
            "tags": self.tags or [],
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class Template(Base):
    """SMS template as authored by the composer (blank content is allowed)."""

    __tablename__ = "templates"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(160), index=True)
    content: Mapped[str] = mapped_column(Text, default="")
    variable_title_pairs: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    assigned_contact_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    updated_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    created_by: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "content": self.content or "",
            "variableTitlePairs": self.variable_title_pairs or [],
            "assignedContactIds": self.assigned_contact_ids or [],
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class ConditionalRule(Base):
    """Maps a FreeShow variable to a template when a condition matches."""

    __tablename__ = "conditional_rules"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    variable_name: Mapped[str] = mapped_column(String(160), index=True)
    condition: Mapped[str] = mapped_column(String(32), default="name-equals")
    template_id: Mapped[str] = mapped_column(String(32), default="")
    created_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    created_by: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "variableName": self.variable_name,
            "condition": self.condition,
            "templateId": self.template_id,
            "createdAt": self.created_at,
        }



class MessageLog(Base):
    __tablename__ = "message_logs"

    id: Mapped[str] = mapped_column(String(48), primary_key=True, default=new_id)
    contact_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    contact_name: Mapped[str] = mapped_column(String(120), default="")
    phone_number: Mapped[str] = mapped_column(String(32), default="")
    message: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    sent_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso, index=True)
    variables: Mapped[dict[str, str]] = mapped_column(JSON, default=dict)
    template_id: Mapped[str] = mapped_column(String(32), default="")
    user_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    created_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "contactId": self.contact_id or "",
            "contactName": self.contact_name or "",
            "phoneNumber": self.phone_number or "",
            "message": self.message or "",
            "status": self.status,
            "sentAt": self.sent_at,
            "variables": self.variables or {},
            "templateId": self.template_id or "",
        }


class AppSetting(Base):
    """Small key/value store for UI + integration settings (JSON encoded)."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, default=dict)
    updated_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    updated_by: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
class Assignment(Base):
    """
    Who is assigned to what, on a given day.

    One row per (calendar day, FreeShow variable). This is the durable
    replacement for "what was on screen that Sunday", and it is what the
    rotation analysis reads.
    """

    __tablename__ = "assignments"
    __table_args__ = (
        UniqueConstraint("assignment_date", "variable_id", name="uq_assignment_day_variable"),
        Index("ix_assignments_date_variable", "assignment_date", "variable_name"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    assignment_date: Mapped[str] = mapped_column(String(10), index=True)
    # The *service date* this entry belongs to (YYYY-MM-DD), when someone knows
    # it explicitly. NULL - the normal case for bridge-written rows - means
    # "derive it from the variable's recurring schedule rule at read time", so
    # correcting a rule also corrects the interpretation of past entries.
    schedule_date: Mapped[Optional[str]] = mapped_column(
        String(10), nullable=True, index=True
    )
    variable_id: Mapped[str] = mapped_column(String(64), index=True)
    variable_name: Mapped[str] = mapped_column(String(160), index=True)
    value: Mapped[str] = mapped_column(String(500), default="")
    # Best-effort link to the contact list (names are free text in FreeShow).
    contact_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True, index=True)
    contact_name: Mapped[str] = mapped_column(String(160), default="", index=True)
    contact_phone: Mapped[str] = mapped_column(String(32), default="")
    # manual | bridge | snapshot | imported
    source: Mapped[str] = mapped_column(String(24), default="bridge")
    note: Mapped[str] = mapped_column(String(500), default="")
    first_seen_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    updated_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    updated_by: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "date": self.assignment_date,
            "scheduleDate": self.schedule_date,
            "variableId": self.variable_id,
            "variableName": self.variable_name,
            "value": self.value or "",
            "contactId": self.contact_id,
            "contactName": self.contact_name or "",
            "contactPhone": self.contact_phone or "",
            "source": self.source,
            "note": self.note or "",
            "firstSeenAt": self.first_seen_at,
            "updatedAt": self.updated_at,
        }
class AssignmentChange(Base):
    """
    Append-only audit trail: every observed from -> to change of a variable.

    This is how "who was assigned previously" is answered without trusting
    anyone's memory: the bridge reports ``changed`` on each snapshot and we
    record it here permanently.
    """

    __tablename__ = "assignment_changes"
    __table_args__ = (
        Index("ix_changes_variable_changed", "variable_name", "changed_at"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    assignment_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    assignment_date: Mapped[str] = mapped_column(String(10), index=True)
    variable_id: Mapped[str] = mapped_column(String(64), index=True)
    variable_name: Mapped[str] = mapped_column(String(160), index=True)
    previous_value: Mapped[str] = mapped_column(String(500), default="")
    new_value: Mapped[str] = mapped_column(String(500), default="")
    previous_contact_name: Mapped[str] = mapped_column(String(160), default="")
    new_contact_name: Mapped[str] = mapped_column(String(160), default="", index=True)
    new_contact_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    # What caused the change: bridge | snapshot | manual | api
    source: Mapped[str] = mapped_column(String(24), default="bridge")
    trigger: Mapped[str] = mapped_column(String(64), default="")
    note: Mapped[str] = mapped_column(String(500), default="")
    changed_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso, index=True)
    user_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "assignmentId": self.assignment_id,
            "date": self.assignment_date,
            "variableId": self.variable_id,
            "variableName": self.variable_name,
            "previousValue": self.previous_value or "",
            "newValue": self.new_value or "",
            "previousContactName": self.previous_contact_name or "",
            "newContactName": self.new_contact_name or "",
            "newContactId": self.new_contact_id,
            "source": self.source,
            "trigger": self.trigger or "",
            "note": self.note or "",
            "changedAt": self.changed_at,
        }


class ScheduleEvent(Base):
    """
    A named service/meeting the user tracks explicitly.

    The bridge only ever sees *variable values*, so it cannot know that
    "2026-09-20" was a Sunday service with a given theme. Users can create a
    ScheduleEvent to label a date (and optionally link the day's assignments),
    which is what makes recurring-cycle reports human readable.
    """

    __tablename__ = "schedule_events"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    title: Mapped[str] = mapped_column(String(200), index=True)
    event_date: Mapped[str] = mapped_column(String(10), index=True)
    # free | sunday-service | midweek | rehearsal | special
    kind: Mapped[str] = mapped_column(String(32), default="free", index=True)
    series_name: Mapped[str] = mapped_column(String(200), default="", index=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    updated_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    created_by: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "date": self.event_date,
            "kind": self.kind,
            "seriesName": self.series_name or "",
            "notes": self.notes or "",
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class ScheduleEventAssignment(Base):
    """
    Link table: which assignments (people) belong to a tracked event.

    Many-to-many because a single assignment row can be part of several
    tracked events, and an event normally spans several assignments.
    """

    __tablename__ = "schedule_event_assignments"
    __table_args__ = (
        UniqueConstraint("event_id", "assignment_id", name="uq_event_assignment"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    event_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("schedule_events.id", ondelete="CASCADE"), index=True
    )
    assignment_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("assignments.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)

    event: Mapped[ScheduleEvent] = relationship()
    assignment: Mapped[Assignment] = relationship()

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "eventId": self.event_id,
            "assignmentId": self.assignment_id,
            "createdAt": self.created_at,
        }


class AssignmentScheduleRule(Base):
    """
    The recurring calendar one assignment variable follows.

    The bridge can only report *when it saw a value change*, which for this
    church is the Sunday evening the next week's schedule is typed in - not the
    service date the assignment is for. A rule supplies the missing calendar:

    * ``weekdays``       - which day(s) the assignment is *for*
                           (0 = Monday ... 6 = Sunday, so [4] = every Friday),
    * ``interval_weeks`` - every week, every other week, ...,
    * ``anchor_date``    - one real occurrence, which fixes the phase of the
                           interval, and
    * ``lead_days``      - how many days before the service the schedule is
                           entered, so a row recorded on 2026-09-20 maps to the
                           service it was entered for (default 1 = "the next
                           upcoming occurrence").

    Rotation analysis turns that into a real service date, which is what makes
    "who is next, and when" land on a Friday/Saturday/Sunday instead of on
    whatever day the schedule happened to be typed in.
    """

    __tablename__ = "assignment_schedules"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    variable_name: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    label: Mapped[str] = mapped_column(String(200), default="")
    weekdays: Mapped[list[int]] = mapped_column(JSON, default=list)
    interval_weeks: Mapped[int] = mapped_column(default=1)
    anchor_date: Mapped[str] = mapped_column(String(10), default="")
    lead_days: Mapped[int] = mapped_column(default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    updated_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    created_by: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    def weekday_labels(self) -> list[str]:
        return [WEEKDAY_NAMES[day] for day in sorted(self.weekdays or []) if 0 <= day <= 6]

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "variableName": self.variable_name,
            "label": self.label or "",
            "weekdays": sorted(self.weekdays or []),
            "weekdayLabels": self.weekday_labels(),
            "intervalWeeks": int(self.interval_weeks or 1),
            "anchorDate": self.anchor_date or "",
            "leadDays": int(self.lead_days or 0),
            "enabled": bool(self.enabled),
            "notes": self.notes or "",
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class AssignmentVersion(Base):
    """
    Immutable snapshot of a day's full assignment set.

    Each row keeps the entire set of ``(variableName -> contactName)`` for one
    date plus a content hash. Writing a version only when the hash changes makes
    "what did the schedule look like on date X" a single indexed lookup, and
    lets the cycle detector compare whole weeks instead of single variables.
    """

    __tablename__ = "assignment_versions"
    __table_args__ = (
        UniqueConstraint("assignment_date", "content_hash", name="uq_version_date_hash"),
        Index("ix_versions_date_created", "assignment_date", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    assignment_date: Mapped[str] = mapped_column(String(10), index=True)
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    items: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    item_count: Mapped[int] = mapped_column(default=0)
    source: Mapped[str] = mapped_column(String(24), default="bridge")
    created_at: Mapped[str] = mapped_column(String(40), default=utc_now_iso)
    created_by: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "date": self.assignment_date,
            "contentHash": self.content_hash,
            "items": self.items or [],
            "itemCount": self.item_count,
            "source": self.source,
            "createdAt": self.created_at,
        }