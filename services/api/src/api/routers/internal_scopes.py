"""Internal scope-authorization seam (ADR-0029, issue #1607).

Two projections of the one ``scope_authz`` registry:

- ``GET /internal/scopes`` — the caller's own reachable scopes for a
  ``permission_code``, for a plugin's picker UI.
- ``POST /internal/scope-check`` — may the caller act at ONE specific
  ``scope_ref``, for the non-listing case (e.g. before minting a row).

Both are dual-authenticated (``require_signed_principal``, ADR-0017 §3/§5): a
SigV4 service principal proves which plugin is calling, and the forwarded,
re-verified token proves which user it acts for. Core, never the plugin, is
the authority on both, and neither alone is sufficient — a browser cannot
reach these routes with a bearer token, and a service cannot act for a
founder it holds no valid token for.

## Why ``permission_code`` is checked first, and why that alone refuses a
## cross-plugin question (issue #1607's fourth fail-first case)

``permission_code`` is the *same* axis #1606 already checks against
``caller.permissions`` (``dependencies.py``'s ``require_crud_permission``) —
"can this caller do this kind of thing at all" — before scope narrows it to
"...at this specific place". A forwarded caller who does not hold the
``permission_code`` is refused here for that identical reason, with no new
per-plugin ownership table needed: a plugin forwarding a token for a founder
who does not hold ``marketing.links.manage`` is refused regardless of which
plugin is doing the asking — what is being examined is always the caller's
own grant, never the calling service's identity. (A table-level ownership
axis over ``permission_code`` — which service may even ask about a given
code — is ``scope_scoped_service.allowed_principals``, issue #1607 step 4,
deliberately not built here.)

Both routes are advisory-then-enforced the same way ``owner_data_handlers``
is: a plugin *should* use ``scope-check``/``scopes`` to build a sane UI, but
neither route is itself the enforcement point for any data write — that is
step 4's ``/internal/scope-data/<table>``, not built here. These two routes
cannot, by construction, drift from that future enforcement because both will
call the same ``scope_authz`` functions.
"""

from __future__ import annotations

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..middleware.principal import Principal, require_signed_principal
from ..scope_authz import authorize_scope, list_reachable_scopes

logger = Logger()

router = APIRouter(prefix="/internal", tags=["internal:scopes"])


class ScopeOptionOut(BaseModel):
    ref: str
    label: str
    depth: int
    parent_ref: str | None


class ScopesResponse(BaseModel):
    scopes: list[ScopeOptionOut]
    # False only when this instance has registered no scope authorizer at
    # all ("could not resolve") — never conflated with a registered
    # authorizer legitimately returning zero scopes ("checked, none").
    resolved: bool
    # The denominator (issue #1607): how many of the caller's own grant refs
    # were examined, and of those, how many the ancestry resolver could not
    # place. An unresolvable ref is unexamined, not silently dropped as fine.
    checked: int
    unresolved: int


class ScopeCheckRequest(BaseModel):
    permission_code: str
    scope_ref: str


class ScopeCheckResponse(BaseModel):
    allowed: bool
    # False only on bare core (no authorizer registered) — see ScopesResponse.
    resolved: bool
    reason: str | None = None


def _require_permission_code(caller: Principal, permission_code: str) -> None:
    """The #1606 axis, ANDed ahead of scope (issue #1607: scope composes with
    ``permission_code`` as an AND, not a rival axis — #1606 is not reopened).

    A caller who does not hold ``permission_code`` at all is refused here,
    server-side, before the scope authorizer is even consulted — this is
    what makes a plugin's attempt to ask about a ``permission_code`` it
    (i.e. the forwarded founder) has no grant for come back refused, whether
    the plugin doing the asking is the code's "own" plugin or not.
    """
    if permission_code not in caller.user.permissions:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to perform this action",
        )


@router.get("/scopes", response_model=ScopesResponse)
async def list_scopes(
    permission_code: str = Query(...),
    caller: Principal = Depends(require_signed_principal),
    db: AsyncSession = Depends(get_db),
) -> ScopesResponse:
    """The caller's own reachable scopes for ``permission_code`` — opaque
    ``ref``/``label``/``depth``/``parent_ref`` only; no instance vocabulary."""
    _require_permission_code(caller, permission_code)
    listing = await list_reachable_scopes(caller.user, db, permission_code)
    if not listing.resolved:
        logger.warning(
            "scope listing could not be resolved: no scope authorizer registered",
            extra={"permission_code": permission_code},
        )
    return ScopesResponse(
        scopes=[
            ScopeOptionOut(ref=o.ref, label=o.label, depth=o.depth, parent_ref=o.parent_ref)
            for o in listing.scopes
        ],
        resolved=listing.resolved,
        checked=listing.checked,
        unresolved=listing.unresolved,
    )


@router.post("/scope-check", response_model=ScopeCheckResponse)
async def scope_check(
    body: ScopeCheckRequest,
    caller: Principal = Depends(require_signed_principal),
    db: AsyncSession = Depends(get_db),
) -> ScopeCheckResponse:
    """May the forwarded caller act at ``body.scope_ref`` for
    ``body.permission_code``? Enforced here, server-side — a plugin asking
    this question gets the real answer, not a hint it re-derives itself."""
    _require_permission_code(caller, body.permission_code)
    result = await authorize_scope(caller.user, db, body.permission_code, body.scope_ref)
    if not result.resolved:
        logger.warning(
            "scope check could not be resolved: no scope authorizer registered",
            extra={"permission_code": body.permission_code, "scope_ref": body.scope_ref},
        )
    elif not result.allowed:
        logger.info(
            "scope check denied",
            extra={"permission_code": body.permission_code, "scope_ref": body.scope_ref},
        )
    return ScopeCheckResponse(
        allowed=result.allowed, resolved=result.resolved, reason=result.reason
    )
