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

## ``permission_code`` is checked on TWO axes, both necessary, neither
## sufficient alone (issue #1644, correcting this module's own earlier claim)

Axis 1 — **the caller's own grant** (#1606's axis, checked against
``caller.user.permissions``, ``dependencies.py``'s
``require_crud_permission``): "can this human do this kind of thing at all".
A forwarded caller who does not hold ``permission_code`` is refused here
before the scope authorizer is even consulted.

Axis 1 alone does **not** refuse a cross-plugin question, and an earlier
version of this docstring and of ADR-0029 claimed it did — false for exactly
the caller population most likely to hold multiple ``permission_code``s (an
HQ admin, a brand manager with cross-domain grants): axis 1 says nothing
about *which plugin is asking*, so any signed plugin forwarding that caller's
token could read another domain's scope refs, human labels, depth and parent
chain (issue #1644).

Axis 2 — **the asking service's own entitlement**, declared by the INSTANCE
(issue #1653). The forwarded caller may hold ``permission_code``, but the
plugin that forwarded them must also be entitled to ask about it, and the
instance is who says so: ``register_scope_authorizer(..., entitlements={
"system:marketing": frozenset({"campaigns.read"})})``, consulted here via
``scope_authz.service_is_entitled``. Nothing a plugin authors is read.

#1644 shipped this axis reading the *plugin's own manifest* — the
``permission_code`` on its tables' CRUD ``permissions`` blocks
(``PermissionRule``, #1606). #1653 found that self-contradictory rather than
merely loose: ``permission_code`` is the instance-specific, DB-held gate a
portable plugin is designed **not** to use (``required_role`` is the portable
one), so no manifest in the estate declares one (0 of 28 ``biffo.plugin.json``
files across every local repository checkout, skeletons included) and the only
route to entitlement was to make the plugin non-portable. It also read a document
the asking plugin writes — captured live against ``origin/dev`` at
``85ae8c69``, a marketing manifest declaring ``workflows.manage`` on its own
``tracked_links`` table returned ``200`` with the caller's full workflows
hierarchy. Both fall out together once the instance — which already owns the
vocabulary (ADR-0012) — is the one that declares the map.

(A *table-level* ownership axis over ``permission_code`` — which service may
read/write a given plugin table's rows — is ``scope_scoped_service.
allowed_principals``, issue #1607 step 4, deliberately not built here; it
gates table access, not this ask/list seam, and neither closes the other.)

## A consequence worth stating: bare core now refuses this seam outright

``resolved=False`` ("no authorizer registered", never "denied") is a real and
tested distinction in ``scope_authz`` — but since #1653 it is **unreachable
over HTTP**, because an instance that registered no authorizer also declared
no entitlements, so axis 2 refuses with a ``403`` before either route body
runs. That is deliberate and strictly more conservative than what it
replaced: an unentitled plugin now learns nothing at all, rather than
learning this instance's registration state. ``ScopesResponse.resolved`` /
``ScopeCheckResponse.resolved`` stay in the contract because they are the
shape step 4's enforcement path will consume from the same registry
functions, but nobody should read their presence as evidence the bare-core
path is exercised on the wire — it is not, and ``tests/test_scope_authz.py``
is where that distinction is actually proven.

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
from ..scope_authz import authorize_scope, list_reachable_scopes, service_is_entitled

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
    """Two checks, both necessary, neither sufficient alone (issue #1644).

    1. **The caller's own grant** (#1606's axis, ANDed ahead of scope — issue
       #1607: scope composes with ``permission_code`` as an AND, not a rival
       axis, #1606 is not reopened). A caller who does not hold
       ``permission_code`` at all is refused here, server-side, before the
       scope authorizer is even consulted.
    2. **The asking service's own entitlement, as the INSTANCE declared it**
       (issue #1653). Axis 1 alone answers "may this human act on this
       permission_code", never "may this plugin ask on their behalf" — a
       forwarded caller who legitimately holds several unrelated
       ``permission_code``s (an HQ admin, a brand manager) is exactly the
       population axis 1 cannot refuse for a plugin asking about a code that
       isn't its own. Refused here unless the instance's own
       ``register_scope_authorizer(entitlements=...)`` map entitles the
       calling service's logical name to this code. Nothing the plugin
       authors is consulted, so a plugin cannot entitle itself.

    The same generic 403 detail is used for both refusals so a caller cannot
    distinguish "you don't hold this" from "your plugin isn't entitled to
    ask this" from the response alone. That opacity is deliberate and stays:
    a plugin author diagnosing a refusal is served by ``biffo plugin info
    <name>``, which explains where entitlement is declared, rather than by a
    hint this seam would also be handing to a prober.
    """
    if permission_code not in caller.user.permissions:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to perform this action",
        )

    service = caller.service
    logical_names = service.logical_names if service is not None else frozenset()
    if not service_is_entitled(logical_names, permission_code):
        logger.warning(
            "scope seam refused: this instance has not entitled the asking service "
            "to this permission_code",
            extra={
                "permission_code": permission_code,
                "principal_arn": service.principal_arn if service is not None else None,
            },
        )
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
