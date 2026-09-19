"""
CRUD for the collections that used to live in ``localStorage``.

Contacts, message templates, conditional rules and message logs are plain
lists from the frontend's point of view, so instead of four near-identical
modules they are described once in ``SPECS`` and wired up in a loop. The
response shapes come from the models' ``to_dict()`` methods, which emit the
same camelCase keys the React types already use — that is why exporting or
importing a backup bundle keeps working unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from db import get_db
from models import ConditionalRule, Contact, MessageLog, Template, User
from security import current_user
from timeutil import utc_now_iso

router = APIRouter(prefix="/api", tags=["collections"])


# --------------------------------------------------------------------------- #
# Specs
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class CollectionSpec:
    kind: str                       # url segment + backup section name
    model: Any                      # ORM class
    fields: dict[str, str]          # camelCase request key -> ORM attribute
    list_types: frozenset[str] = frozenset()   # attributes holding JSON lists
    defaults: dict[str, Any] = field(default_factory=dict)
    searchable: tuple[str, ...] = ()
    order_by: str = "name"
    order_desc: bool = False
    bulk: bool = False              # POST accepts {"logs": [...]} as well
    id_max_length: int = 32


SPECS: tuple[CollectionSpec, ...] = (
    CollectionSpec(
        kind="contacts",
        model=Contact,
        fields={
            "name": "name",
            "phoneNumber": "phone_number",
            "nicknames": "nicknames",
            "tags": "tags",
        },
        list_types=frozenset({"nicknames", "tags"}),
        searchable=("name", "phone_number"),
        order_by="name",
    ),
    CollectionSpec(
        kind="templates",
        model=Template,
        fields={
            "name": "name",
            "content": "content",
            "variableTitlePairs": "variable_title_pairs",
            "assignedContactIds": "assigned_contact_ids",
        },
        list_types=frozenset({"variable_title_pairs", "assigned_contact_ids"}),
        searchable=("name", "content"),
        order_by="updated_at",
        order_desc=True,
    ),
    CollectionSpec(
        kind="rules",
        model=ConditionalRule,
        fields={
            "variableName": "variable_name",
            "condition": "condition",
            "templateId": "template_id",
        },
        defaults={"condition": "name-equals"},
        searchable=("variable_name",),
        order_by="created_at",
    ),
    CollectionSpec(
        kind="logs",
        model=MessageLog,
        fields={
            "contactId": "contact_id",
            "contactName": "contact_name",
            "phoneNumber": "phone_number",
            "message": "message",
            "status": "status",
            "sentAt": "sent_at",
            "variables": "variables",
            "templateId": "template_id",
        },
        defaults={"status": "pending"},
        searchable=("contact_name", "phone_number", "message"),
        order_by="sent_at",
        order_desc=True,
        bulk=True,
        id_max_length=48,
    ),
)

SPEC_BY_KIND = {spec.kind: spec for spec in SPECS}


def spec_for(kind: str) -> CollectionSpec:
    spec = SPEC_BY_KIND.get(kind)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Unknown collection '{kind}'")
    return spec


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _clean_value(value: Any, is_list: bool) -> Any:
    if is_list:
        return list(value or []) if isinstance(value, (list, tuple)) else []
    if isinstance(value, (dict, list)):
        return value
    if value is None:
        return ""
    return str(value)


def _apply(obj: Any, payload: dict[str, Any], spec: CollectionSpec) -> bool:
    """Copy whitelisted payload keys onto the model. Returns True if changed."""
    changed = False
    for key, attr in spec.fields.items():
        if key not in payload:
            continue
        value = _clean_value(payload[key], attr in spec.list_types)
        if getattr(obj, attr) != value:
            setattr(obj, attr, value)
            changed = True
    if changed and hasattr(obj, "updated_at"):
        obj.updated_at = utc_now_iso()
    return changed


def _orders(spec: CollectionSpec):
    column = getattr(spec.model, spec.order_by)
    return column.desc() if spec.order_desc else column.asc()


def _row_id(value: str, spec: CollectionSpec) -> str:
    """Validate an incoming id before touching the ORM."""
    cleaned = (value or "").strip()
    if not cleaned or len(cleaned) > spec.id_max_length:
        raise HTTPException(status_code=400, detail="Invalid id")
    return cleaned


# --------------------------------------------------------------------------- #
# Route factory
# --------------------------------------------------------------------------- #
def _insert(db: Session, spec: CollectionSpec, payload: dict[str, Any], user: User) -> Any:
    """Build a row from a payload, preserving client-supplied ids when valid."""
    kwargs: dict[str, Any] = {}
    supplied = str(payload.get("id") or "").strip()
    if supplied and len(supplied) <= spec.id_max_length:
        kwargs["id"] = supplied
    for key, default in spec.defaults.items():
        kwargs[spec.fields[key]] = default
    row = spec.model(**kwargs)
    if hasattr(row, "created_by"):
        row.created_by = None if user.username == "machine" else user.id
    if hasattr(row, "user_id"):
        row.user_id = None if user.username == "machine" else user.id
    _apply(row, payload, spec)
    db.add(row)
    return row


def _register(spec: CollectionSpec) -> None:
    kind = spec.kind
    path = f"/{kind}"

    @router.get(path, name=f"list_{kind}")
    def list_items(
        search: Optional[str] = Query(default=None),
        limit: int = Query(default=1000, ge=1, le=20000),
        db: Session = Depends(get_db),
        _: User = Depends(current_user),
    ) -> dict[str, Any]:
        query = select(spec.model)
        if search and spec.searchable:
            needle = f"%{search.strip().lower()}%"
            query = query.where(
                or_(
                    *[
                        func.lower(getattr(spec.model, column)).like(needle)
                        for column in spec.searchable
                    ]
                )
            )
        rows = db.scalars(query.order_by(_orders(spec)).limit(limit)).all()
        items = [row.to_dict() for row in rows]
        return {kind: items, "count": len(items)}

    @router.post(path, status_code=201, name=f"create_{kind}")
    async def create_item(
        request: Request,
        db: Session = Depends(get_db),
        user: User = Depends(current_user),
    ) -> dict[str, Any]:
        payload = await request.json()
        # Bulk append: {"logs": [ ... ]} (status is decided by the client).
        if spec.bulk and isinstance(payload, dict) and isinstance(payload.get(kind), list):
            rows = [item for item in payload[kind] if isinstance(item, dict)]
            created = [_insert(db, spec, item, user) for item in rows]
            db.commit()
            items = [row.to_dict() for row in created]
            return {kind: items, "count": len(items), "item": items[-1] if items else None}

        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="Body must be a JSON object")
        row = _insert(db, spec, payload, user)
        db.commit()
        item = row.to_dict()
        return {"ok": True, "item": item}

    @router.patch(f"{path}/{{item_id}}", name=f"update_{kind}")
    async def update_item(
        item_id: str,
        request: Request,
        db: Session = Depends(get_db),
        _: User = Depends(current_user),
    ) -> dict[str, Any]:
        row = db.get(spec.model, _row_id(item_id, spec))
        if row is None:
            raise HTTPException(status_code=404, detail="Not found")
        payload = await request.json()
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="Body must be a JSON object")
        _apply(row, payload, spec)
        db.commit()
        return {"ok": True, "item": row.to_dict()}

    @router.delete(f"{path}/{{item_id}}", name=f"delete_{kind}")
    def delete_item(
        item_id: str,
        db: Session = Depends(get_db),
        _: User = Depends(current_user),
    ) -> dict[str, Any]:
        row = db.get(spec.model, _row_id(item_id, spec))
        if row is None:
            raise HTTPException(status_code=404, detail="Not found")
        db.delete(row)
        db.commit()
        return {"ok": True}


for _spec in SPECS:
    _register(_spec)
# --------------------------------------------------------------------------- #
# Contacts: nickname helpers (the UI edits nicknames one at a time)
# --------------------------------------------------------------------------- #
@router.post("/contacts/{contact_id}/nicknames")
async def add_nickname(
    contact_id: str,
    request: Request,
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
) -> dict[str, Any]:
    contact = db.get(Contact, _row_id(contact_id, SPEC_BY_KIND["contacts"]))
    if contact is None:
        raise HTTPException(status_code=404, detail="Contact not found")
    payload = await request.json()
    nickname = str((payload or {}).get("nickname") or "").strip()
    if not nickname:
        raise HTTPException(status_code=400, detail="'nickname' is required")

    nicknames = list(contact.nicknames or [])
    if nickname not in nicknames:
        nicknames.append(nickname)
    contact.nicknames = nicknames
    contact.updated_at = utc_now_iso()
    db.commit()
    return {"ok": True, "item": contact.to_dict()}


@router.delete("/contacts/{contact_id}/nicknames")
async def remove_nickname(
    contact_id: str,
    request: Request,
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
) -> dict[str, Any]:
    contact = db.get(Contact, _row_id(contact_id, SPEC_BY_KIND["contacts"]))
    if contact is None:
        raise HTTPException(status_code=404, detail="Contact not found")
    payload = await request.json()
    nickname = str((payload or {}).get("nickname") or "").strip()
    contact.nicknames = [n for n in (contact.nicknames or []) if n != nickname]
    contact.updated_at = utc_now_iso()
    db.commit()
    return {"ok": True, "item": contact.to_dict()}


# --------------------------------------------------------------------------- #
# Logs: clear-all (mirrors the old localStorage "Clear History" button)
# --------------------------------------------------------------------------- #
@router.delete("/logs")
def clear_logs(
    db: Session = Depends(get_db), _: User = Depends(current_user)
) -> dict[str, Any]:
    removed = 0
    for row in db.scalars(select(MessageLog)).all():
        db.delete(row)
        removed += 1
    db.commit()
    return {"ok": True, "removed": removed}
    return cleaned