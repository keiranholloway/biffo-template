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

from aws_lambda_powertools import Logger
from fastapi import Body, Depends, HTTPException, status
from pydantic_core import to_jsonable_python
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..dependencies import require_plugin_tenant_context
from ..events import emit_event
from ..events.registry import EventType

logger = Logger()

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
AUTO_COLUMN_NAMES: frozenset[str] = frozenset({"id", "tenant_id", "created_at", "updated_at"})

# The soft-delete marker. A model carrying this column is tombstoned by the
# delete handler rather than destroyed, and its tombstoned rows are excluded
# from every generic read. Deliberately NOT in AUTO_COLUMN_NAMES: that set
# mirrors TenantScopedModel's own columns, and this one is not on the base —
# it is opt-in per model, declared by simply having the column.
SOFT_DELETE_COLUMN = "deleted_at"


def serialize(row: Any) -> dict[str, Any]:
    """Convert a mapped row into a plain JSON-able dict of its own columns."""
    return {col.name: getattr(row, col.name) for col in row.__table__.columns}


def soft_delete_attr(model: type[Any]) -> Any | None:
    """The model's soft-delete marker attribute, or ``None`` if this model is
    hard-deleted.

    A model opts in by declaring a ``deleted_at`` column — the same signal the
    hand-written domain endpoints already use — and can opt back out with
    ``__soft_delete__ = False`` for a table that genuinely wants rows destroyed
    (an append-only log being pruned, say). Presence of the column is the
    trigger because that is what the DDL and the instances' own queries already
    treat as authoritative; requiring a second declaration would be one more
    hand-maintained copy of a fact the schema already states.
    """
    if not getattr(model, "__soft_delete__", True):
        return None
    if SOFT_DELETE_COLUMN not in model.__table__.columns:
        return None
    return getattr(model, SOFT_DELETE_COLUMN, model.__table__.columns[SOFT_DELETE_COLUMN])


def _visible(model: type[Any], query: Any) -> Any:
    """Narrow a query to rows that are not tombstoned. A no-op for a model with
    no soft-delete column, so every caller can apply it unconditionally."""
    tombstone = soft_delete_attr(model)
    return query if tombstone is None else query.where(tombstone.is_(None))


def user_columns_from_model(model: type[Any]) -> frozenset[str]:
    """Column names a caller may set via the request body — every column on the
    model except the auto-managed id/tenant_id/created_at/updated_at ones and
    the ``deleted_at`` soft-delete marker. ``tenant_id`` in particular must
    never be settable from the body: it always comes from
    require_plugin_tenant_context (ADR-0001), and ``deleted_at`` must not be
    either — a body-settable tombstone lets any caller with ``update`` delete a
    row, or resurrect one, without ever holding the ``delete`` permission."""
    return frozenset(
        c.name
        for c in model.__table__.columns
        if c.name not in AUTO_COLUMN_NAMES and c.name != SOFT_DELETE_COLUMN
    )


def _reject_unwritable_fields(payload: dict[str, Any], user_columns: frozenset[str]) -> None:
    """422 on any payload key that isn't a user-writable column, instead of the
    old behaviour of silently ignoring it (``if key in user_columns`` with no
    else). Silent drop is worse than a straightforward rejection: the handler
    still returns 200/201 with the full serialized row, so a caller checking
    only the status code concludes an unknown/unwritable field (a typo, or
    ``id``/``tenant_id``/``deleted_at``) was written when it was dropped on the
    floor (tabsii-platform#474). This only rejects keys NOT in ``user_columns``
    — a partial payload that supplies a subset of writable fields is untouched.
    """
    unknown = sorted(set(payload) - user_columns)
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Unwritable or unknown field(s): {', '.join(unknown)}",
        )


# SQLSTATE class 23 = integrity constraint violation (PostgreSQL). asyncpg sets
# ``.sqlstate`` on every ``PostgresError`` it raises, so this is driver-neutral
# even though it's a Postgres code — it's what ``exc.orig`` carries in
# production (postgresql+asyncpg). Other DBAPIs (e.g. the sqlite3 driver the
# test suite runs against) won't have `.sqlstate`, hence the ``getattr`` below
# and the generic fallback message — never `str(exc.orig)`.
_INTEGRITY_ERROR_MESSAGES: dict[str, str] = {
    "23505": "That value conflicts with an existing record.",
    "23503": "This action references a record that does not exist.",
    "23502": "A required value is missing.",
    "23514": "That value does not satisfy a required condition.",
}
_DEFAULT_INTEGRITY_MESSAGE = "That value conflicts with an existing record."


def _integrity_error_response(
    exc: IntegrityError, *, model: type[Any], operation: str
) -> HTTPException:
    """Map a driver ``IntegrityError`` to a stable, generic 400.

    The raw driver exception (``exc.orig``) is schema reconnaissance handed to
    any authenticated caller — driver name, exception class, physical table
    name, constraint name — and it's unstable, breaking whenever the
    driver/constraint wording changes (tabsii-platform#473). None of that
    reaches the response. The real detail is logged server-side at WARN
    (correlated automatically via ``Logger.inject_lambda_context`` on the
    Lambda entrypoint); the caller gets a stable, generic message and, when the
    driver names one, a machine-readable ``constraint`` field.
    """
    sqlstate = getattr(exc.orig, "sqlstate", None)
    constraint = getattr(exc.orig, "constraint_name", None)
    message = (
        _INTEGRITY_ERROR_MESSAGES.get(sqlstate, _DEFAULT_INTEGRITY_MESSAGE)
        if isinstance(sqlstate, str)
        else _DEFAULT_INTEGRITY_MESSAGE
    )
    logger.warning(
        f"IntegrityError on {operation} {model.__tablename__}",
        extra={
            "table": model.__tablename__,
            "operation": operation,
            "sqlstate": sqlstate,
            "constraint": constraint,
            "driver_detail": str(exc.orig),
        },
    )
    detail: dict[str, Any] = {"message": message}
    if constraint:
        detail["constraint"] = constraint
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


def make_list_handler(model: type[Any]) -> Callable[..., Awaitable[Any]]:
    async def handler(
        tenant_id: str = Depends(require_plugin_tenant_context),
        db: AsyncSession = Depends(get_db),
    ) -> list[dict[str, Any]]:
        query = _visible(model, select(model).where(model.tenant_id == tenant_id))
        result = await db.execute(query)
        return [serialize(row) for row in result.scalars().all()]

    return handler


def make_read_handler(model: type[Any]) -> Callable[..., Awaitable[Any]]:
    async def handler(
        id: str,
        tenant_id: str = Depends(require_plugin_tenant_context),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        query = _visible(model, select(model).where(model.id == id, model.tenant_id == tenant_id))
        result = await db.execute(query)
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
        return serialize(row)

    return handler


async def _run_created_hook(model: type[Any], db: AsyncSession, row: Any, tenant_id: Any) -> None:
    """Give a model a say in what its creation *means*, beyond the row.

    The `<table>.created` event this layer emits is a faithful record of a row
    appearing, and for most tables that is the whole story. For some it is not:
    a row of foreign keys can be a genuine business moment whose useful payload
    needs a lookup the CRUD layer has no business doing — tabsii's
    `user_role_assignments` row means "someone was granted access to this
    brand", and an automation that reacts to it wants the person's email, which
    the row does not carry.

    A model opts in with an async `__on_created__(db, row, tenant_id)`. It runs
    **after** the generic event, on the same session, so anything it emits is
    buffered and published by the same post-commit path (ADR-0002) and is
    dropped with the row if the transaction rolls back.

    The alternative was a bespoke create route per such table, which would mean
    reimplementing tenant injection and the RLS `WITH CHECK` this handler
    already gets right — duplicating a write path to add an event to it is a bad
    trade on any table, and a worse one on a grant.
    """
    hook = getattr(model, "__on_created__", None)
    if hook is None:
        return
    await hook(db, row, tenant_id)


def make_create_handler(
    model: type[Any], user_columns: frozenset[str]
) -> Callable[..., Awaitable[Any]]:
    async def handler(
        payload: dict[str, Any] = Body(default_factory=dict),
        tenant_id: str = Depends(require_plugin_tenant_context),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        _reject_unwritable_fields(payload, user_columns)
        row = model(tenant_id=tenant_id, **payload)
        db.add(row)
        try:
            await db.flush()
        except IntegrityError as exc:
            raise _integrity_error_response(exc, model=model, operation="create") from exc
        await db.refresh(row)
        _emit_crud_event(db, model, "created", tenant_id, row=row)
        await _run_created_hook(model, db, row, tenant_id)
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
        _reject_unwritable_fields(payload, user_columns)
        # A tombstoned row is invisible to read, so it must be invisible to
        # update too — otherwise a caller who cannot see a row can still write
        # to it, and the 404 read becomes a lie rather than a boundary.
        query = _visible(model, select(model).where(model.id == id, model.tenant_id == tenant_id))
        result = await db.execute(query)
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
        for key, value in payload.items():
            setattr(row, key, value)
        try:
            await db.flush()
        except IntegrityError as exc:
            raise _integrity_error_response(exc, model=model, operation="update") from exc
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
        query = _visible(model, select(model).where(model.id == id, model.tenant_id == tenant_id))
        result = await db.execute(query)
        row = result.scalar_one_or_none()
        if row is None:
            # Includes an already-tombstoned row: deleting one twice is a 404,
            # not a second `<table>.deleted` event for the same row.
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
        # Capture the row for the event before it's deleted/expired.
        exclude = frozenset(getattr(model, "__event_exclude__", ()) or ())
        deleted_payload = _event_payload(row, exclude)
        tombstone = soft_delete_attr(model)
        if tombstone is None:
            await db.delete(row)
            await db.flush()
        else:
            # A model carrying deleted_at is tombstoned, never destroyed. The
            # SQL is an UPDATE, so it is the table's UPDATE grants and RLS
            # UPDATE policy that govern it — not its DELETE ones. A table
            # exposing generic delete on a soft-delete model needs an UPDATE
            # policy that admits the caller; a DELETE policy alone will not
            # authorise this and the row will not be found to update.
            setattr(row, SOFT_DELETE_COLUMN, func.now())
            await db.flush()
            await db.refresh(row)
            deleted_payload = _event_payload(row, exclude)
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
