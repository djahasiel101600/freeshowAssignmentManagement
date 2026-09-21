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
from typing import Any, Iterator

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
    ensure_columns()
    log.info("Database ready at %s", DATABASE_URL)


# --------------------------------------------------------------------------- #
# Schema upgrades
# --------------------------------------------------------------------------- #
# ``create_all()`` only creates missing *tables*; a column appended to a model
# that already shipped needs an explicit ALTER. Keeping those here (rather than
# pulling in a migration tool) matches the single-container SQLite deployment:
# every entry is idempotent, so running it on each startup is harmless.
#
# (table, column, DDL type, index name)
ADDED_COLUMNS: tuple[tuple[str, str, str, str | None], ...] = (
    # Service date an assignment is *for*, vs the day the bridge recorded it.
    ("assignments", "schedule_date", "VARCHAR(10)", "ix_assignments_schedule_date"),
)


def _columns_on(connection: Any, table: str) -> set[str]:
    """Column names as *this* connection sees them."""
    if connection.dialect.name == "sqlite":
        rows = connection.exec_driver_sql(f'PRAGMA table_info("{table}")').fetchall()
        return {str(row[1]) for row in rows}
    from sqlalchemy import text

    rows = connection.execute(
        text(
            "SELECT column_name FROM information_schema.columns"
            " WHERE table_schema = current_schema() AND table_name = :table"
        ),
        {"table": table},
    ).fetchall()
    return {str(row[0]) for row in rows}


def ensure_columns() -> list[str]:
    """
    Add columns (and their indexes) that post-date the initial schema.

    Returns the list of ``"table.column"`` upgrades applied, which makes the
    function easy to assert in tests and easy to log on startup.

    SQLite validates ``ALTER TABLE ... ADD COLUMN`` against the schema a
    *connection* has cached, and the pool can hold a connection whose view
    predates the change (another worker, or a migration run by hand). So an
    "already exists" error is treated as success and the end state is then
    re-verified on brand-new connections - if a column really is missing the
    operator gets one clear error at startup instead of odd failures later.
    """
    from sqlalchemy import inspect, text
    from sqlalchemy.exc import OperationalError

    tables = set(inspect(engine).get_table_names())
    applied: list[str] = []
    already: list[str] = []

    with engine.begin() as connection:
        for table, column, ddl_type, index_name in ADDED_COLUMNS:
            if table not in tables:
                continue  # create_all() just built it complete
            if column not in _columns_on(connection, table):
                try:
                    connection.execute(
                        text(f'ALTER TABLE "{table}" ADD COLUMN "{column}" {ddl_type}')
                    )
                    applied.append(f"{table}.{column}")
                    log.info("Schema upgrade: added %s.%s", table, column)
                except OperationalError as exc:
                    message = str(exc).lower()
                    if "duplicate column" not in message and "already exists" not in message:
                        raise
                    already.append(f"{table}.{column}")
            if index_name:
                connection.execute(
                    text(f'CREATE INDEX IF NOT EXISTS "{index_name}" ON "{table}" ("{column}")')
                )

    # True-up with fresh connections: the pool may still be holding a connection
    # with a stale SQLite schema view.
    engine.dispose()
    with engine.connect() as fresh:
        missing = [
            f"{table}.{column}"
            for table, column, _ddl, _index in ADDED_COLUMNS
            if table in tables and column not in _columns_on(fresh, table)
        ]
    if missing:
        raise RuntimeError(
            "Schema upgrade failed for: "
            + ", ".join(missing)
            + " - check the database file/permissions and restart."
        )
    if already:
        log.debug("Schema upgrade: %s already present", ", ".join(already))
    return applied


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
