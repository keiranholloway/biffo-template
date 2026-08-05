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

List filtering: the ``list`` handler narrows on the scope columns a model
declares (``filterable_columns``) and rejects, with a 400, any query parameter
it cannot honour. It used to accept no query parameters at all, so every filter
sent over HTTP was silently discarded and a caller whose grant spanned several
scopes received every scope's rows for a single-scope request (tabsii-crm#239).
Filters only ever AND conditions onto the tenant-scoped SELECT; they cannot
widen what tenant scoping (or, in an instance, RLS) already permits.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from datetime import date, datetime
from typing import Any, cast
from uuid import UUID

from aws_lambda_powertools import Logger
from fastapi import Body, Depends, HTTPException, Request, status
from pydantic_core import to_jsonable_python
from sqlalchemy import Date, DateTime, String, Uuid, func, select
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


def visible_rows(model: type[Any], query: Any) -> Any:
    """Narrow a query to rows that are not tombstoned. A no-op for a model with
    no soft-delete column, so every caller can apply it unconditionally — which
    is the point: the owner-data handlers share it, so there is one place that
    decides what "still exists" means rather than two that can drift."""
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


# Column types a list filter can compare against a raw query-string value.
# Exactly the types `_coerce_user_field` converts (Uuid, DateTime, Date) plus
# String/Text, which needs no conversion because a text column and a query
# parameter are already the same thing. Everything else is deliberately absent:
# JSON, ARRAY and geometry types have no useful equality-against-a-string
# semantics, and Integer/Float/Boolean would reach the driver as strings and
# surface as a 500 — so they stay rejected until someone adds their coercion
# beside the others.
_FILTERABLE_TYPES: tuple[type[Any], ...] = (Uuid, String, DateTime, Date)


def _coerce_user_field(model: type[Any], key: str, value: Any) -> Any:
    """Coerce one caller-supplied value to what its column needs before it is
    compared.

    A query string has no UUID, datetime or date type, so a typed column's
    filter arrives as text. SQLAlchemy's bind processors then raise at execute
    rather than coercing, which surfaces to the caller as a 500 — "the server is
    broken" — for what is plainly bad input. Convert here instead, and 400 on
    something unparseable: the same "bad input is a 400" contract the rest of
    this layer follows. ``None`` and already-native values pass straight
    through; column types outside the conversion set are untouched, so a
    ``String`` table behaves exactly as before.

    Deliberately scoped to the **filter** path for now. The create/update body
    path has the same shape of problem and does not use this yet; an instance
    that has diverged (tabsii-platform) already applies it to both, and bringing
    the body path upstream is its own change with its own tests rather than a
    silent rider on this one.
    """
    column = model.__table__.columns.get(key)
    if column is None or value is None or not isinstance(value, str):
        return value
    if isinstance(column.type, Uuid):
        try:
            return UUID(value)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"{key} is not a valid UUID",
            ) from exc
    if isinstance(column.type, DateTime):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"{key} is not a valid datetime",
            ) from exc
    if isinstance(column.type, Date):
        try:
            return date.fromisoformat(value)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"{key} is not a valid date",
            ) from exc
    return value


def filterable_columns(model: type[Any]) -> frozenset[str]:
    """Query-parameter names a generic list route will honour as equality
    filters on ``model`` — derived from the model's own columns, never a
    hardcoded list.

    The rule: **every user column whose type can be compared against a raw
    query-string value** (``_FILTERABLE_TYPES``). ``user_columns_from_model``
    supplies the "user column" half, so the auto-managed columns and the
    ``deleted_at`` tombstone are excluded here for the same reasons they are
    excluded from the write path — ``tenant_id`` in particular is never a
    caller's to choose, it comes from the tenant-context dependency (ADR-0001),
    and it ends in ``_id`` so it has to be excluded deliberately.

    ## Why column type rather than declared foreign keys

    Foreign-key metadata would be the more direct signal for *scope* columns,
    and it is not usable — for reasons that are properties of how these tables
    come to exist, not an oversight anyone can fix later:

    * A **plugin** table is built from a manifest, and ``ColumnDefinition`` has
      no way to declare a ``ForeignKey`` at all (``models/plugin_table.py``), so
      a dynamically-built model never carries one.
    * An **instance's** DDL-imported tables keep their real constraints in SQL
      rather than in the mapped model: ``tabsii-platform``'s entire
      ``api/models`` package declares zero SQLAlchemy foreign keys — measured,
      not assumed.
    * The one place a **core** model does declare one — ``User.organization_id``
      — belongs to a table that deliberately stays off the generic CRUD layer
      (ADR-0004 §1), so it is not a counter-example this rule ever sees.

    Deriving the allowed set from ``column.foreign_keys`` would therefore yield
    an empty set on every table this handler serves and quietly filter nothing:
    the estate's standard failure shape, a check that passes because it cannot
    see its input.

    ## Why not only ``_id`` columns

    Scope is carried by foreign keys, so an ``_id`` suffix names most of what
    matters, and an earlier draft of this rule allowed only that. The type rule
    is wider on purpose: hand-written list routes exist in instances *solely*
    because this layer could not filter, and retiring them onto generic CRUD
    needs ``status`` as much as it needs ``brand_id``. Honouring every filter
    this layer can honour correctly is what eventually removes the "do not
    simplify this back to generic CRUD" warnings rather than restating them.

    A column outside the set is **rejected**, naming itself, rather than
    silently ignored — see ``apply_list_filters``. Widening later means adding a
    type to ``_FILTERABLE_TYPES`` plus its coercion in ``_coerce_user_field``;
    nothing else reads this set.
    """
    user_columns = user_columns_from_model(model)
    return frozenset(
        column.name
        for column in model.__table__.columns
        if column.name in user_columns and isinstance(column.type, _FILTERABLE_TYPES)
    )


def apply_list_filters(
    model: type[Any],
    query: Any,
    query_params: Sequence[tuple[str, str]],
    *,
    filterable: frozenset[str] | None = None,
) -> Any:
    """AND the caller's equality filters onto an already-scoped list ``query``,
    rejecting anything this layer will not honour.

    ``query`` arrives already carrying whatever scoping the route enforces —
    tenant for the generic list route, tenant *and* owner for the owner-scoped
    one (``owner_data_handlers``). This function only ever narrows it further,
    so no query parameter can widen a result beyond what the caller was already
    entitled to; the scoping predicates are not this function's to relax.

    ``query_params`` is the raw ``(name, value)`` sequence — Starlette's
    ``request.query_params.multi_items()`` — deliberately not a dict, so a
    parameter repeated in the query string is *visible* here rather than
    silently collapsed to its last occurrence.

    Three ways a caller is told "no", all of them 400 and all of them naming the
    parameter at fault:

    * a parameter this route cannot filter on (``filterable``);
    * the same parameter more than once — last-wins would be a silent choice
      between two things the caller asked for, which is the defect, not the fix;
    * a value that is not valid for its column, e.g. a non-UUID for a ``Uuid``
      column (``_coerce_user_field``), which would otherwise reach the driver
      and surface as a 500.

    **Why loud rejection is the point.** Both list surfaces used to drop what
    they could not honour on the floor: the generic one took no query parameters
    at all (tabsii-crm#239) and the owner-scoped one had an ``if key in
    user_columns`` with no ``else`` (tabsii-platform#665). Either way the filter
    was accepted by FastAPI, discarded, and answered with a 200 — a caller could
    not tell that ``?brand_id=X`` had narrowed nothing. Scoping was never
    bypassed (it still is not; this only ever ANDs conditions on), so the answer
    was authorised — it was simply not the answer that was asked for. Converting
    a silent wrong answer into a visible error is the whole objective, and it is
    why an unrecognised parameter is a 400 rather than a shrug.

    This is a pure query builder with no session access, so it is testable
    without a database and, in an instance, executable on an RLS-bound
    connection to observe the narrowing under live policies.
    """
    if filterable is None:
        filterable = filterable_columns(model)

    names = [name for name, _ in query_params]

    unknown = sorted({name for name in names if name not in filterable})
    if unknown:
        supported = (
            f"This endpoint filters on: {', '.join(sorted(filterable))}."
            if filterable
            else "This endpoint accepts no filters."
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported query parameter(s): {', '.join(unknown)}. {supported}",
        )

    repeated = sorted({name for name in names if names.count(name) > 1})
    if repeated:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Query parameter(s) given more than once: {', '.join(repeated)}. "
                "Provide each filter at most once."
            ),
        )

    for name, value in query_params:
        query = query.where(getattr(model, name) == _coerce_user_field(model, name, value))
    return query


def build_list_query(
    model: type[Any],
    tenant_id: Any,
    query_params: Sequence[tuple[str, str]],
    *,
    filterable: frozenset[str] | None = None,
) -> Any:
    """The SELECT behind the generic list route: tenant-scoped, tombstone-free,
    and narrowed by whichever filters the caller asked for.

    Only the base query is this function's own; every rejection and coercion
    rule lives in ``apply_list_filters``, which the owner-scoped list route
    shares. Two list handlers deciding independently what an unknown parameter
    is worth is exactly the drift that had ``_extract_detail`` written twice
    (biffo-template#1108).
    """
    return apply_list_filters(
        model,
        visible_rows(model, select(model).where(model.tenant_id == tenant_id)),
        query_params,
        filterable=filterable,
    )


# Default for the list handler's ``request`` parameter, so the handler stays
# callable as a plain coroutine — several tests exercise it that way, and a
# direct call has no query string to read.
#
# Spelled as a cast rather than ``Request | None`` because FastAPI recognises the
# parameter by its **annotation**: a plain ``Request`` is injected from the ASGI
# scope, while ``Request | None`` is a Union it does not special-case and instead
# tries to build a Pydantic field from, which raises at import time. The default
# is invisible over HTTP — FastAPI always supplies the real request — so the
# ``None`` branch is reachable only from an in-process call.
#
# "No request" therefore means "no query string", which resolves to no filters:
# the tenant-scoped result the route returned before filtering existed. That is
# the widest answer this handler has ever given and it is still tenant-bounded,
# so the fallback cannot widen scope — it only declines to narrow.
_NO_REQUEST: Request = cast(Request, None)


def make_list_handler(model: type[Any]) -> Callable[..., Awaitable[Any]]:
    # Resolved once per route at build time — the model's columns cannot change
    # between requests, and this is what the 400 message quotes back.
    filterable = filterable_columns(model)

    async def handler(
        tenant_id: str = Depends(require_plugin_tenant_context),
        db: AsyncSession = Depends(get_db),
        request: Request = _NO_REQUEST,
    ) -> list[dict[str, Any]]:
        params = list(request.query_params.multi_items()) if request is not None else []
        query = build_list_query(model, tenant_id, params, filterable=filterable)
        result = await db.execute(query)
        return [serialize(row) for row in result.scalars().all()]

    return handler


def make_read_handler(model: type[Any]) -> Callable[..., Awaitable[Any]]:
    async def handler(
        id: str,
        tenant_id: str = Depends(require_plugin_tenant_context),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        query = visible_rows(
            model, select(model).where(model.id == id, model.tenant_id == tenant_id)
        )
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
        query = visible_rows(
            model, select(model).where(model.id == id, model.tenant_id == tenant_id)
        )
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
        query = visible_rows(
            model, select(model).where(model.id == id, model.tenant_id == tenant_id)
        )
        result = await db.execute(query)
        row = result.scalar_one_or_none()
        if row is None:
            # Includes an already-tombstoned row: deleting one twice is a 404,
            # not a second `<table>.deleted` event for the same row.
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
        exclude = frozenset(getattr(model, "__event_exclude__", ()) or ())
        tombstone = soft_delete_attr(model)
        if tombstone is None:
            # Capture the row for the event before it's deleted/expired.
            deleted_payload = _event_payload(row, exclude)
            await db.delete(row)
            await db.flush()
        else:
            # A model carrying deleted_at is tombstoned, never destroyed, and
            # the event carries the tombstoned row — deleted_at included, so a
            # consumer can see when it happened.
            #
            # Note for a table under RLS: this makes the statement an UPDATE,
            # so the table's UPDATE grants and UPDATE policy are what must
            # admit the caller. A DELETE policy alone no longer authorises the
            # generic delete on such a table.
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
