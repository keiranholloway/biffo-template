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

Axis 2 — **the asking service's own entitlement**, added here. The forwarded
caller may hold ``permission_code``, but the plugin that forwarded them must
also be entitled to ask about it. Entitlement is derived from something every
plugin already declares, not a new hand-maintained ownership list: a plugin's
own ``biffo.plugin.json`` names ``permission_code`` on its own tables' CRUD
``permissions`` blocks (``PermissionRule.permission_code``, #1606) — the
codes it declares anywhere are the codes it may ask about here. A plugin
whose manifest names a ``permission_code`` nowhere has no legitimate reason
to ask about it, and this seam now refuses that ask rather than trusting the
caller's grant alone. See ``_service_entitled_permission_codes`` below.

(A *table-level* ownership axis over ``permission_code`` — which service may
read/write a given plugin table's rows — is ``scope_scoped_service.
allowed_principals``, issue #1607 step 4, deliberately not built here; it
gates table access, not this ask/list seam, and neither closes the other.)

Both routes are advisory-then-enforced the same way ``owner_data_handlers``
is: a plugin *should* use ``scope-check``/``scopes`` to build a sane UI, but
neither route is itself the enforcement point for any data write — that is
step 4's ``/internal/scope-data/<table>``, not built here. These two routes
cannot, by construction, drift from that future enforcement because both will
call the same ``scope_authz`` functions.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..middleware.principal import Principal, require_signed_principal
from ..migrations.plugin_migrations import parse_plugin_tables_from_manifest
from ..models.plugin_table import CRUD_OPERATIONS
from ..plugins import discover_plugin_manifests
from ..scope_authz import authorize_scope, list_reachable_scopes

logger = Logger()

router = APIRouter(prefix="/internal", tags=["internal:scopes"])


def _plugin_permission_codes(manifests: Sequence[dict[str, Any]]) -> dict[str, frozenset[str]]:
    """``system:<plugin-name>`` -> every ``permission_code`` that plugin's own
    manifest declares anywhere across its tables' CRUD ``permissions`` blocks.

    This is the #1606 axis a manifest already carries
    (``PermissionRule.permission_code`` on each of a table's ``list``/
    ``read``/``create``/``update``/``delete`` rules) — reused here as an
    entitlement source rather than inventing a second, hand-maintained
    "which plugin owns which code" list (issue #1644 is explicit that a
    parallel registry is the wrong shape). A plugin that never names a code
    on any of its own tables is entitled to ask about none of them.

    A manifest that fails to parse is skipped (logged, not raised) —
    ``discover_plugin_manifests`` already applies this same fail-open-on-
    disk-scan/fail-closed-on-entitlement split for the permissions registry
    (``permissions.py``); one broken manifest must not take down every other
    plugin's ability to use this seam, and a plugin that fails to parse is
    simply entitled to nothing, which is the fail-closed outcome that matters
    here.
    """
    result: dict[str, frozenset[str]] = {}
    for manifest in manifests:
        name = manifest.get("name")
        if not isinstance(name, str) or not name:
            continue
        try:
            tables = parse_plugin_tables_from_manifest(manifest)
        except (ValueError, TypeError) as exc:
            logger.warning(
                f"Skipping scope-seam entitlement for plugin {name!r}: invalid manifest: {exc}"
            )
            continue
        codes = {
            rule.permission_code
            for table in tables
            for op in CRUD_OPERATIONS
            for rule in (getattr(table.permissions, op),)
            if rule.permission_code
        }
        result[f"system:{name}"] = frozenset(codes)
    return result


def _service_entitled_permission_codes(logical_names: frozenset[str]) -> frozenset[str]:
    """The union of ``permission_code``s every one of ``logical_names``'s
    plugins is entitled to ask about, per its own installed manifest.

    Reads ``discover_plugin_manifests()`` fresh on every call rather than
    caching process-wide: this seam is a low-volume picker/pre-check path
    (never the generic CRUD hot path ``get_permissions_registry`` memoises
    for), and a fresh read means a newly-installed or newly-updated manifest
    takes effect on the very next request rather than waiting for a cold
    start. ``logical_names`` is normally a single ``{"system:<name>"}``
    (``ServicePrincipal.logical_names``); iterating is defensive, not a claim
    that a caller ever carries more than one.
    """
    by_plugin = _plugin_permission_codes(discover_plugin_manifests())
    codes: set[str] = set()
    for name in logical_names:
        codes |= by_plugin.get(name, frozenset())
    return frozenset(codes)


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
    2. **The asking service's own entitlement.** Axis 1 alone answers "may
       this human act on this permission_code", never "may this plugin ask
       on their behalf" — a forwarded caller who legitimately holds several
       unrelated ``permission_code``s (an HQ admin, a brand manager) is
       exactly the population axis 1 cannot refuse for a plugin asking about
       a code that isn't its own. Refused here unless the calling service's
       own manifest names ``permission_code`` on at least one of its own
       tables (see ``_service_entitled_permission_codes``).

    The same generic 403 detail is used for both refusals so a caller cannot
    distinguish "you don't hold this" from "your plugin isn't entitled to
    ask this" from the response alone.
    """
    if permission_code not in caller.user.permissions:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to perform this action",
        )

    service = caller.service
    logical_names = service.logical_names if service is not None else frozenset()
    if permission_code not in _service_entitled_permission_codes(logical_names):
        logger.warning(
            "scope seam refused: asking service not entitled to this permission_code",
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
