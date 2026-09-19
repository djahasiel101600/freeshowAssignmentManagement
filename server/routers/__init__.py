"""API routers for the receiver.

Each module exposes a single ``router`` (a ``fastapi.APIRouter``); ``app.py``
includes the ones below. Keeping them split by domain keeps ``app.py`` focused
on the bridge receiver + reverse proxies.
"""

from __future__ import annotations

from routers import assignments, auth, collections, rotation, settings

ROUTERS = (
    auth.router,
    collections.router,
    assignments.router,
    rotation.router,
    settings.router,
)

__all__ = ["ROUTERS"]