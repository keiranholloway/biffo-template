"""Owner-scoped, service-authenticated CRUD handlers (ADR-0017 §5).

The write/read path a plugin's own Lambda uses to manage its CRUD-closed tables —
distinct from the tenant-scoped generic handlers (``crud_handlers.py``) on two
axes at once:

- **Dual authentication.** Every handler requires a SigV4 service principal
  (ADR-0009) *and* a forwarded, re-verified founder (ADR-0017 §3). Neither alone
  suffices, and both now arrive as one :class:`Principal` from
  ``require_signed_principal`` (#621): a Cognito user with no IAM principal is
  refused by its service gate, a service call with no forwarded user token is
  refused by its user gate. The forwarded token is verified through the same
  ``authenticated_identity`` as a browser's bearer token, so the deactivation
  gate (#150) and permission resolution reach these routes by construction.
- **Owner scoping is not optional and not from the request.** The owner is the
  *verified founder's* subject, taken from the re-verified token and written to /
  filtered on the table's declared ``owner_column``. It is never read from the body
  or query, so a plugin cannot act for a founder it does not hold a valid token
  for, nor reach another owner's rows. Tenant scoping (ADR-0001) still applies on
  top, unconditionally.

The service principal must additionally be one the table *named* (its
``owner_scoped_service.allowed_principals``); a principal the table did not name is
answered **404**, indistinguishable from a table that does not exist — so one
plugin cannot even probe another's owner-scoped tables.

These handlers deliberately emit **no** CRUD events: a closed, owner-scoped table's
rows are the owning module's private state, not a bus signal.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Body, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..middleware.auth import AuthenticatedUser
from ..middleware.principal import Principal, require_signed_principal
from .crud_handlers import apply_list_filters, filterable_columns, serialize, visible_rows

Handler = Callable[..., Awaitable[Any]]


def _owner_id(founder: AuthenticatedUser) -> str:
    """The owner a row is scoped to — the verified founder's canonical id, else its
    subject. Matches how ``run_as_user_id`` is derived on the chat routes."""
    return founder.user_id or founder.sub


def _authorize(caller: Principal, allowed: frozenset[str]) -> None:
    """404 (not 403) when the calling service is not one this table named — an
    ungranted table must look nonexistent (ADR-0004 §4 indistinguishability).

    Reads the service off the principal. ``require_signed_principal`` guarantees
    it is present, but the ``None`` branch is spelled out rather than asserted:
    an absent service resolves to no logical names, which intersects nothing and
    yields the same 404 — fail-closed if that guarantee ever weakens."""
    logical_names = caller.service.logical_names if caller.service else frozenset()
    if not logical_names & allowed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


def make_owner_create_handler(
    model: type[Any], owner_column: str, user_columns: frozenset[str], allowed: frozenset[str]
) -> Handler:
    # The owner column is set from the token, never the body.
    settable = user_columns - {owner_column}

    async def handler(
        payload: dict[str, Any] = Body(default_factory=dict),
        caller: Principal = Depends(require_signed_principal),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        _authorize(caller, allowed)
        founder = caller.user
        fields = {k: v for k, v in payload.items() if k in settable}
        row = model(tenant_id=founder.tenant_id, **{owner_column: _owner_id(founder)}, **fields)
        db.add(row)
        try:
            await db.flush()
        except IntegrityError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Could not create {model.__tablename__} row: {exc.orig}",
            ) from exc
        await db.refresh(row)
        return serialize(row)

    return handler


def _owned(model: type[Any], owner_column: str, founder: AuthenticatedUser):
    """A base SELECT scoped to this founder's rows on this tenant, excluding
    tombstoned ones.

    These handlers have no delete verb, so nothing here *creates* a tombstone —
    but a model reached this way may also be exposed through the tenant-scoped
    handlers, or soft-deleted by a bespoke domain endpoint, and a row that is
    deleted everywhere else must not still be visible here.
    """
    return visible_rows(
        model,
        select(model).where(
            model.tenant_id == founder.tenant_id,
            getattr(model, owner_column) == _owner_id(founder),
        ),
    )


def make_owner_read_handler(
    model: type[Any], owner_column: str, allowed: frozenset[str]
) -> Handler:
    async def handler(
        id: str,
        caller: Principal = Depends(require_signed_principal),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        _authorize(caller, allowed)
        founder = caller.user
        row = (
            await db.execute(_owned(model, owner_column, founder).where(model.id == id))
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
        return serialize(row)

    return handler


def make_owner_list_handler(
    model: type[Any], owner_column: str, allowed: frozenset[str]
) -> Handler:
    """List this founder's rows, narrowed by whichever equality filters the
    caller asked for and this table can honour.

    The accepted set is ``filterable_columns`` minus the owner column. Excluding
    the owner is not a security control — ``_owned`` ANDs the verified founder
    on unconditionally, so no query parameter has ever been able to widen the
    result past their own rows — it is a correctness one: ``?owner_sub=someone``
    can only ever mean "narrow to a founder I am not", and the honest answer to
    that is a 400 naming the parameter, not a 200 for a different question.

    Rejection and coercion are ``crud_handlers.apply_list_filters``, shared with
    the tenant-scoped list route rather than reimplemented. What this handler
    used to do instead — ``if key in user_columns`` with no ``else``, over
    ``.items()`` rather than ``.multi_items()``, with no value coercion — had
    three distinct failure modes in four lines (tabsii-platform#665): an
    unrecognised parameter silently returned every row the founder owned with a
    200, a repeated parameter collapsed to its last occurrence, and a non-UUID
    for a ``Uuid`` column reached the driver and surfaced as a 500. The shared
    helper answers all three with a 400 that names the parameter.
    """
    # Resolved once per route at build time — a model's columns cannot change
    # between requests, and this is what the 400 message quotes back.
    filterable = filterable_columns(model) - {owner_column}

    async def handler(
        request: Request,
        caller: Principal = Depends(require_signed_principal),
        db: AsyncSession = Depends(get_db),
    ) -> list[dict[str, Any]]:
        _authorize(caller, allowed)
        founder = caller.user
        stmt = apply_list_filters(
            model,
            _owned(model, owner_column, founder),
            list(request.query_params.multi_items()),
            filterable=filterable,
        )
        rows = (await db.execute(stmt)).scalars().all()
        return [serialize(row) for row in rows]

    return handler


def make_owner_update_handler(
    model: type[Any], owner_column: str, user_columns: frozenset[str], allowed: frozenset[str]
) -> Handler:
    # The owner column is immutable — a row can never be re-owned via update.
    settable = user_columns - {owner_column}

    async def handler(
        id: str,
        payload: dict[str, Any] = Body(default_factory=dict),
        caller: Principal = Depends(require_signed_principal),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        _authorize(caller, allowed)
        founder = caller.user
        row = (
            await db.execute(_owned(model, owner_column, founder).where(model.id == id))
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
        for key, value in payload.items():
            if key in settable:
                setattr(row, key, value)
        try:
            await db.flush()
        except IntegrityError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Could not update {model.__tablename__} row: {exc.orig}",
            ) from exc
        await db.refresh(row)
        return serialize(row)

    return handler
