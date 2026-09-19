"""
Database bootstrap (SQLAlchemy 2.x + SQLite).

The database file lives in ``DATA_DIR`` — the same directory the JSON snapshot
files use — so it is persisted by the existing ``freeshow-sms-server-data``
Docker volume with no extra infrastructure.

Why SQLite: the workload is a handful of writers and a few thousand rows
(schedules, contacts, logs). SQLite in WAL mode handles that comfortably and
keeps the deployment a single container with no extra service to run.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session as OrmSession, sessionmaker

log = logging.getLogger("freeshow.db")

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", str(BASE_DIR / "data"))).expanduser()
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = Path(os.environ.get("DB_PATH", str(DATA_DIR / "freeshow.db"))).expanduser()
DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DB_PATH}")

_is_sqlite = DATABASE_URL.startswith("sqlite")

engine = create_engine(
    DATABASE_URL,
    echo=False,
    future=True,
    pool_pre_ping=True,
    connect_args={"check_same_thread": False} if _is_sqlite else {},
)


if _is_sqlite:

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _connection_record) -> None:  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        # WAL lets readers (the API) run while a writer commits.
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()


class Base(DeclarativeBase):
    """Declarative base for every ORM model."""


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db() -> None:
    """Create any missing tables. Safe to call on every startup."""
    # Import models so they register with Base.metadata before create_all().
    # Done inside the function to avoid a circular import (models imports Base).
    import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    log.info("Database ready at %s", DATABASE_URL)


def get_db() -> Iterator[OrmSession]:
    """FastAPI dependency yielding a scoped session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def session_scope() -> OrmSession:
    """Session for non-request code (startup seeding, background helpers)."""
    return SessionLocal()
