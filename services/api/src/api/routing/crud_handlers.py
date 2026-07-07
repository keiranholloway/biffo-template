"""Generic CRUD request handlers, shared by the plugin router
(``routing/plugin_router.py``) and the core-table router
(``routing/core_crud_router.py``).

A handler is synthesized against a SQLAlchemy model — whether that model was
built dynamically from a plugin manifest (``PluginTableDefinition.
to_sqlalchemy_model``) or is a hand-written core ``TenantScopedModel`` subclass
makes no difference here. Every handler is tenant-scoped unconditionally via
``require_plugin_tenant_context`` (ADR-0001): ``tenant_id`` always comes from
the verified caller, never the request body, and every query is filtered by it.

Authorization is NOT done here — it is a separate route-level guard
(``dependencies.require_crud_permission``) attached by each router, so a handler
only ever runs for a ``(table, operation)`` the caller is already allowed to
perform (ADR-0004).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Body, Depends, HTTPException, status
from pydantic_core import to_jsonable_python
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..dependencies import require_plugin_tenant_context
from ..events import emit_event
from ..events.registry import EventType

# Column names never put on the bus — credentials/secrets/PII. Matched
# case-insensitively as substrings; a model may exclude more via a
# ``__event_exclude__`` ClassVar. State-change events carry the row, so this is
# the guard that keeps a table's secret/token/PII column off EventBridge.
_SENSITIVE_SUBSTRINGS = (
    "password",
    "secret",
    "token",
    "api_key",
    "apikey",
    "private_key",
    "credential",
    "ssn",
)


def _event_payload(row: Any, exclude: frozenset[str]) -> dict[str, Any]:
    """JSON-safe dict of the row's columns for an event payload, minus sensitive
    and explicitly-excluded columns. ``to_jsonable_python`` normalises datetimes/
    UUIDs/Decimals that the raw ``serialize`` leaves as native objects."""
    out: dict[str, Any] = {}
    for col in row.__table__.columns:
        name = col.name
        if name in exclude or any(s in name.lower() for s in _SENSITIVE_SUBSTRINGS):
            continue
        out[name] = to_jsonable_python(getattr(row, name))
    return out


def _emit_crud_event(
    db: AsyncSession,
    model: type[Any],
    op: str,
    tenant_id: Any,
    *,
    row: Any = None,
    payload: dict[str, Any] | None = None,
) -> None:
    """Buffer a ``<table>.<op>`` state-change event (ADR-0002 / #222) for the
    mutation just performed. ``op`` is ``created``/``updated``/``deleted``. A model
    opts out with ``__emit_events__ = False``. Published after commit by get_db;
    the event is declared implicitly by the table's ``__crud_permissions__``."""
    if not getattr(model, "__emit_events__", True):
        return
    table = model.__tablename__
    exclude = frozenset(getattr(model, "__event_exclude__", ()) or ())
    data = payload if payload is not None else _event_payload(row, exclude)
    event = EventType(
        source="biffo.core",
        detail_type=f"{table}.{op}",
        label=f"{table} {op}",
        description=f"A {table} row was {op}.",
    )
    emit_event(db, event, data, tenant_id=str(tenant_id))


# Auto-managed columns (ADR-0001) — never settable from a request body. Kept in
# sync with TenantScopedModel in models/base.py / _AUTO_COLUMNS in
# models/plugin_table.py.
AUTO_COLUMN_NAMES: frozenset[str] = frozenset(
    {"id", "tenant_id", "created_at", "updated_at"}
)


def serialize(row: Any) -> dict[str, Any]:
    """Convert a mapped row into a plain JSON-able dict of its own columns."""
    return {col.name: getattr(row, col.name) for col in row.__table__.columns}


def user_columns_from_model(model: type[Any]) -> frozenset[str]:
    """Column names a caller may set via the request body — every column on the
    model except the auto-managed id/tenant_id/created_at/updated_at ones.
    ``tenant_id`` in particular must never be settable from the body: it always
    comes from require_plugin_tenant_context (ADR-0001)."""
    return frozenset(
        c.name for c in model.__table__.columns if c.name not in AUTO_COLUMN_NAMES
    )


def make_list_handler(model: type[Any]) -> Callable[..., Awaitable[Any]]:
    async def handler(
        tenant_id: str = Depends(require_plugin_tenant_context),
        db: AsyncSession = Depends(get_db),
    ) -> list[dict[str, Any]]:
        result = await db.execute(select(model).where(model.tenant_id == tenant_id))
        return [serialize(row) for row in result.scalars().all()]

    return handler


def make_read_handler(model: type[Any]) -> Callable[..., Awaitable[Any]]:
    async def handler(
        id: str,
        tenant_id: str = Depends(require_plugin_tenant_context),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        result = await db.execute(
            select(model).where(model.id == id, model.tenant_id == tenant_id)
        )
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Not found"
            )
        return serialize(row)

    return handler


def make_create_handler(
    model: type[Any], user_columns: frozenset[str]
) -> Callable[..., Awaitable[Any]]:
    async def handler(
        payload: dict[str, Any] = Body(default_factory=dict),
        tenant_id: str = Depends(require_plugin_tenant_context),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        fields = {k: v for k, v in payload.items() if k in user_columns}
        row = model(tenant_id=tenant_id, **fields)
        db.add(row)
        try:
            await db.flush()
        except IntegrityError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Could not create {model.__tablename__} row: {exc.orig}",
            ) from exc
        await db.refresh(row)
        _emit_crud_event(db, model, "created", tenant_id, row=row)
        return serialize(row)

    return handler


def make_update_handler(
    model: type[Any], user_columns: frozenset[str]
) -> Callable[..., Awaitable[Any]]:
    async def handler(
        id: str,
        payload: dict[str, Any] = Body(default_factory=dict),
        tenant_id: str = Depends(require_plugin_tenant_context),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        result = await db.execute(
            select(model).where(model.id == id, model.tenant_id == tenant_id)
        )
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Not found"
            )
        for key, value in payload.items():
            if key in user_columns:
                setattr(row, key, value)
        try:
            await db.flush()
        except IntegrityError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Could not update {model.__tablename__} row: {exc.orig}",
            ) from exc
        await db.refresh(row)
        _emit_crud_event(db, model, "updated", tenant_id, row=row)
        return serialize(row)

    return handler


def make_delete_handler(model: type[Any]) -> Callable[..., Awaitable[Any]]:
    async def handler(
        id: str,
        tenant_id: str = Depends(require_plugin_tenant_context),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        result = await db.execute(
            select(model).where(model.id == id, model.tenant_id == tenant_id)
        )
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Not found"
            )
        # Capture the row for the event before it's deleted/expired.
        exclude = frozenset(getattr(model, "__event_exclude__", ()) or ())
        deleted_payload = _event_payload(row, exclude)
        await db.delete(row)
        await db.flush()
        _emit_crud_event(db, model, "deleted", tenant_id, payload=deleted_payload)
        return {"deleted": True, "id": id}

    return handler


# operation name -> factory building the handler for it. create/update also
# need the user-settable column set; list/read/delete ignore it.
HANDLER_FACTORIES: dict[
    str, Callable[[type[Any], frozenset[str]], Callable[..., Awaitable[Any]]]
] = {
    "list": lambda model, _cols: make_list_handler(model),
    "read": lambda model, _cols: make_read_handler(model),
    "create": make_create_handler,
    "update": make_update_handler,
    "delete": lambda model, _cols: make_delete_handler(model),
}

SUCCESS_STATUS: dict[str, int] = {
    "list": status.HTTP_200_OK,
    "read": status.HTTP_200_OK,
    "create": status.HTTP_201_CREATED,
    "update": status.HTTP_200_OK,
    "delete": status.HTTP_200_OK,
}
