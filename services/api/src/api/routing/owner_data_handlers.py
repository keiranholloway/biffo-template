"""Owner-scoped, service-authenticated CRUD handlers (ADR-0017 §5).

The write/read path a plugin's own Lambda uses to manage its CRUD-closed tables —
distinct from the tenant-scoped generic handlers (``crud_handlers.py``) on two
axes at once:

- **Dual authentication.** Every handler requires a SigV4 service principal
  (ADR-0009) *and* a forwarded, re-verified founder (ADR-0017 §3). Neither alone
  suffices: a Cognito user with no IAM principal is rejected by
  ``require_service_principal``; a service call with no forwarded token is rejected
  by ``require_forwarded_user``.
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
from ..middleware.forwarded_user import require_forwarded_user
from ..middleware.service_auth import ServicePrincipal, require_service_principal
from .crud_handlers import serialize

Handler = Callable[..., Awaitable[Any]]


def _owner_id(founder: AuthenticatedUser) -> str:
    """The owner a row is scoped to — the verified founder's canonical id, else its
    subject. Matches how ``run_as_user_id`` is derived on the chat routes."""
    return founder.user_id or founder.sub


def _authorize(principal: ServicePrincipal, allowed: frozenset[str]) -> None:
    """404 (not 403) when the calling principal is not one this table named — an
    ungranted table must look nonexistent (ADR-0004 §4 indistinguishability)."""
    if not principal.logical_names & allowed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


def make_owner_create_handler(
    model: type[Any], owner_column: str, user_columns: frozenset[str], allowed: frozenset[str]
) -> Handler:
    # The owner column is set from the token, never the body.
    settable = user_columns - {owner_column}

    async def handler(
        payload: dict[str, Any] = Body(default_factory=dict),
        principal: ServicePrincipal = Depends(require_service_principal),
        founder: AuthenticatedUser = Depends(require_forwarded_user),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        _authorize(principal, allowed)
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
    """A base SELECT scoped to this founder's rows on this tenant."""
    return select(model).where(
        model.tenant_id == founder.tenant_id,
        getattr(model, owner_column) == _owner_id(founder),
    )


def make_owner_read_handler(
    model: type[Any], owner_column: str, allowed: frozenset[str]
) -> Handler:
    async def handler(
        id: str,
        principal: ServicePrincipal = Depends(require_service_principal),
        founder: AuthenticatedUser = Depends(require_forwarded_user),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        _authorize(principal, allowed)
        row = (
            await db.execute(_owned(model, owner_column, founder).where(model.id == id))
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
        return serialize(row)

    return handler


def make_owner_list_handler(
    model: type[Any], owner_column: str, user_columns: frozenset[str], allowed: frozenset[str]
) -> Handler:
    async def handler(
        request: Request,
        principal: ServicePrincipal = Depends(require_service_principal),
        founder: AuthenticatedUser = Depends(require_forwarded_user),
        db: AsyncSession = Depends(get_db),
    ) -> list[dict[str, Any]]:
        _authorize(principal, allowed)
        stmt = _owned(model, owner_column, founder)
        # Optional equality filters on user columns (e.g. by session_id). The owner
        # filter is always ANDed on top and can never be relaxed by a query param —
        # the owner column itself is not an accepted filter key.
        for key, value in request.query_params.items():
            if key in user_columns and key != owner_column:
                stmt = stmt.where(getattr(model, key) == value)
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
        principal: ServicePrincipal = Depends(require_service_principal),
        founder: AuthenticatedUser = Depends(require_forwarded_user),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        _authorize(principal, allowed)
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
