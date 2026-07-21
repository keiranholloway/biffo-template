"""Admin endpoint: enumerate the live generic-CRUD endpoints and their required
roles (ADR-0004 permissions, surfaced for the portal's endpoints view).

This mirrors what ``routing/plugin_router.py`` and ``routing/core_crud_router.py``
actually mount — an endpoint appears here only if it is genuinely reachable
(the operation is ``allowed``) — so it's a faithful "what's live" listing, not a
declaration dump.
"""

from collections.abc import Iterable, Sequence
from typing import Any

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import ValidationError

from ...config import settings
from ...dependencies import require_admin
from ...endpoint_control import (
    LambdaSignerInvoker,
    SignerInvocationError,
    SignerInvoker,
    request_permission_change,
)
from ...middleware.auth import AuthenticatedUser, require_auth
from ...migrations.plugin_migrations import parse_plugin_tables_from_manifest
from ...models.plugin_route import parse_plugin_routes_from_manifest
from ...models.plugin_table import CRUD_OPERATIONS, TablePermissions
from ...openapi_introspect import build_endpoint_detail, collect_openapi_endpoints
from ...permissions import iter_core_crud_models
from ...plugins import discover_plugin_manifests
from ...schemas.endpoint import (
    EndpointDetail,
    EndpointPermissionRequest,
    EndpointPermissionResult,
    EndpointResponse,
)

logger = Logger()

router = APIRouter(prefix="/admin/endpoints", tags=["admin"])

# Mirrors routing/core_crud_router.py's _OPERATION_ROUTE: operation -> (method,
# addresses a single row via /{id}). Kept here so this listing matches how the
# core router builds its paths.
_CORE_OPERATION_ROUTE: dict[str, tuple[str, bool]] = {
    "list": ("GET", False),
    "create": ("POST", False),
    "read": ("GET", True),
    "update": ("PUT", True),
    "delete": ("DELETE", True),
}


def collect_endpoints(
    manifests: Sequence[dict[str, Any]] | None = None,
    core_models: Iterable[type[Any]] | None = None,
) -> list[EndpointResponse]:
    """Enumerate every live generic-CRUD endpoint (plugin + core), sorted by
    path then method. Defaults to the installed plugins and opted-in core models
    on this deployment; tests pass explicit inputs."""
    manifests = discover_plugin_manifests() if manifests is None else manifests
    models = iter_core_crud_models() if core_models is None else list(core_models)

    out: list[EndpointResponse] = []

    for manifest in manifests:
        name = manifest.get("name", "<unknown>")
        try:
            tables = {t.name: t for t in parse_plugin_tables_from_manifest(manifest)}
            routes = parse_plugin_routes_from_manifest(manifest)
        except (ValueError, TypeError) as exc:
            logger.warning(f"Skipping endpoints for plugin {name!r}: invalid manifest: {exc}")
            continue
        for route in routes:
            table = tables.get(route.table)
            if table is None:
                continue
            rule = getattr(table.permissions, route.operation)
            if not rule.allowed:
                continue  # declared but not exposed -> not live
            out.append(
                EndpointResponse(
                    source="plugin",
                    plugin=name,
                    table=route.table,
                    operation=route.operation,
                    method=route.method,
                    path=f"/api/v1/plugins/{name}{route.path}",
                    required_role=list(rule.required_role),
                )
            )

    for model in models:
        raw = getattr(model, "__crud_permissions__", {}) or {}
        try:
            perms = TablePermissions.model_validate(raw)
        except ValidationError as exc:
            logger.warning(
                f"Skipping endpoints for core table "
                f"{getattr(model, '__tablename__', model)!r}: invalid permissions: {exc}"
            )
            continue
        table = model.__tablename__
        for operation in CRUD_OPERATIONS:
            rule = getattr(perms, operation)
            if not rule.allowed:
                continue
            method, is_row = _CORE_OPERATION_ROUTE[operation]
            path = f"/api/v1/data/{table}/{{id}}" if is_row else f"/api/v1/data/{table}"
            out.append(
                EndpointResponse(
                    source="core",
                    plugin=None,
                    table=table,
                    operation=operation,
                    method=method,
                    path=path,
                    required_role=list(rule.required_role),
                )
            )

    out.sort(key=lambda e: (e.path, e.method))
    return out


@router.get("", response_model=list[EndpointResponse])
async def list_endpoints(
    request: Request,
    _caller: AuthenticatedUser = Depends(require_auth),
) -> list[EndpointResponse]:
    """List every mounted API route on this deployment (from the app's OpenAPI
    schema), enriched with generic-CRUD permission metadata where a route matches
    one. Read-only; auth required (same rationale as /admin/plugins)."""
    return collect_openapi_endpoints(request.app.openapi(), collect_endpoints())


@router.get("/detail", response_model=EndpointDetail)
async def endpoint_detail(
    request: Request,
    method: str,
    path: str,
    _caller: AuthenticatedUser = Depends(require_auth),
) -> EndpointDetail:
    """The request/response specifics for one route, derived from OpenAPI (the
    swagger-ish detail panel). ``method``+``path`` identify the route exactly as
    listed by ``GET /admin/endpoints``. Read-only; auth required."""
    detail = build_endpoint_detail(request.app.openapi(), method, path)
    if detail is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No such endpoint: {method.upper()} {path}",
        )
    return detail


# The signer invoker is a warm-reused singleton (like the event publisher). It's
# only constructed when the control plane is configured; tests replace it.
_invoker: SignerInvoker | None = None


def _get_invoker() -> SignerInvoker:
    global _invoker
    if _invoker is None:
        _invoker = LambdaSignerInvoker(settings.pr_signer_function_name)
    return _invoker


@router.post(
    "/permission",
    response_model=EndpointPermissionResult,
    status_code=status.HTTP_202_ACCEPTED,
)
async def change_endpoint_permission(
    body: EndpointPermissionRequest,
    caller: AuthenticatedUser = Depends(require_admin),
) -> EndpointPermissionResult:
    """Request a change to one plugin table/operation's API permission (ADR-0008).

    **Admin only.** This mutates nothing live — it invokes the isolated PR-signer
    (the Core API never holds the GitHub credential), which opens a pull request.
    The change deploys only when that PR is merged through the normal pipeline
    (config-as-code, ADR-0004). Returns **202** with the PR URL and branch.

    The signer is the last-gate validator; its status is relayed: ``409`` when
    the permission is already set that way or the edit is invalid, ``400`` for a
    bad request, ``502`` if the signer or GitHub fails.
    """
    if not settings.pr_signer_function_name:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="The endpoint control plane is not configured on this deployment.",
        )

    requester = caller.email or caller.username or caller.sub
    try:
        result = request_permission_change(
            _get_invoker(),
            plugin=body.plugin,
            table=body.table,
            operation=body.operation,
            allowed=body.allowed,
            required_role=body.required_role,
            requester=requester,
        )
    except SignerInvocationError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

    if result.status == 200 and result.pr_url and result.branch:
        logger.info(
            "endpoint permission change requested",
            extra={
                "requester": requester,
                "plugin": body.plugin,
                "table": body.table,
                "operation": body.operation,
                "pr_url": result.pr_url,
            },
        )
        return EndpointPermissionResult(pr_url=result.pr_url, branch=result.branch)

    # Relay the signer's own status where it's a meaningful client error.
    mapped = result.status if result.status in (400, 409) else status.HTTP_502_BAD_GATEWAY
    raise HTTPException(
        status_code=mapped,
        detail=result.error or "The PR-signer could not complete the request.",
    )
