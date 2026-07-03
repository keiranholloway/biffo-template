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
from fastapi import APIRouter, Depends
from pydantic import ValidationError

from ...middleware.auth import AuthenticatedUser, require_auth
from ...migrations.plugin_migrations import parse_plugin_tables_from_manifest
from ...models.plugin_route import parse_plugin_routes_from_manifest
from ...models.plugin_table import CRUD_OPERATIONS, TablePermissions
from ...permissions import iter_core_crud_models
from ...plugins import discover_plugin_manifests
from ...schemas.endpoint import EndpointResponse

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
            logger.warning(
                f"Skipping endpoints for plugin {name!r}: invalid manifest: {exc}"
            )
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
    _caller: AuthenticatedUser = Depends(require_auth),
) -> list[EndpointResponse]:
    """List the live generic-CRUD endpoints on this deployment and the role each
    requires. Read-only; auth required (same rationale as /admin/plugins)."""
    return collect_endpoints()
