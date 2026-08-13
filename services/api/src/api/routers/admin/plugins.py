"""Admin endpoints for plugin discovery (ADR-0003)."""

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Depends

from ...middleware.auth import AuthenticatedUser, require_auth
from ...migrations.plugin_migrations import parse_plugin_tables_from_manifest
from ...models.plugin_route import RouteDefinition, parse_plugin_routes_from_manifest
from ...models.plugin_ui_components import parse_admin_nav_label_from_manifest
from ...models.plugin_user_surface import parse_admin_ingress_from_manifest
from ...plugins import discover_plugin_manifests
from ...schemas.plugin import InstalledPluginResponse

logger = Logger()

router = APIRouter(prefix="/admin/plugins", tags=["admin"])


@router.get("/available", response_model=list[InstalledPluginResponse])
async def list_available_plugins(
    _caller: AuthenticatedUser = Depends(require_auth),
) -> list[InstalledPluginResponse]:
    """List installed plugins (services/*/biffo.plugin.json) with their table
    schemas and registered routes (issue #19).

    Deliberately uses require_auth only, not require_tenant_context (CLAUDE.md
    invariant #2 — normally every route is tenant-scoped). That invariant
    exists so DB reads/writes stay isolated per tenant_id (ADR-0001); this
    endpoint does neither. It reads plugin manifests off disk and returns the
    same result for every tenant on this deployment (which plugins are
    installed is a property of the deployment, not of a tenant). Requiring
    require_tenant_context here would demand a tenant_id this endpoint has no
    use for, without adding any actual isolation. Authentication is still
    required — an installed-plugin/table-schema listing shouldn't be public.

    A plugin whose route declarations fail validation is still listed (with
    its table schema), just with an empty `routes` list and a logged
    warning — one plugin's bad manifest shouldn't make every installed
    plugin disappear from this listing.
    """
    manifests = discover_plugin_manifests()
    responses: list[InstalledPluginResponse] = []
    for manifest in manifests:
        name = manifest.get("name", "<unknown>")
        try:
            routes: list[RouteDefinition] = parse_plugin_routes_from_manifest(manifest)
        except ValueError as exc:
            logger.warning(
                f"Plugin {name!r} has invalid route declarations, omitting from listing: {exc}"
            )
            routes = []

        admin_ingress = parse_admin_ingress_from_manifest(manifest)

        try:
            admin_nav_label = parse_admin_nav_label_from_manifest(manifest)
        except ValueError as exc:
            logger.warning(
                f"Plugin {name!r} has invalid ui_components declarations, "
                f"omitting admin nav label: {exc}"
            )
            admin_nav_label = None

        responses.append(
            InstalledPluginResponse(
                name=name,
                version=manifest.get("version", "0.0.0"),
                description=manifest.get("description", ""),
                tables=parse_plugin_tables_from_manifest(manifest),
                routes=routes,
                has_admin_ingress=admin_ingress is not None,
                admin_required_group=admin_ingress.required_group
                if admin_ingress is not None
                else None,
                admin_nav_label=admin_nav_label,
            )
        )
    return responses
