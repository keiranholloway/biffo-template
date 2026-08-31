"""Dynamic FastAPI route registration for plugin-declared routes (ADR-0003
chunk 6 / issue #19).

Builds one ``APIRouter`` covering every installed plugin's declared routes
(``api_routes`` in ``biffo.plugin.json``), mounted under
``/plugins/<plugin-name>/<path>`` — ``main.py`` includes this router with
``prefix="/api/v1"``, giving the full path
``/api/v1/plugins/<plugin-name>/<path>``.

Design: a plugin route is not linked-in code (see
``api.models.plugin_route`` for the fuller rationale, grounded in ADR-0002).
It is a declaration of ``(method, path, table, operation)``, and this module
synthesizes a generic CRUD handler for each one (from ``routing.crud_handlers``)
against the plugin's own SQLAlchemy model (``PluginTableDefinition.
to_sqlalchemy_model()``, from issue #18), scoped to the caller's ``tenant_id``
via ``require_plugin_tenant_context`` — the same tenant-scoping every
hand-written route uses (CLAUDE.md invariant #2).

Authorization (ADR-0004): each route also carries a ``require_crud_permission``
guard, resolved against the permissions registry built from the *same*
manifests these routes are built from. A ``(table, operation)`` that isn't
allowed for the caller is 404 (not exposed) or 403 (exposed but the caller
lacks the required role) — enforced before the handler runs. Default-deny: a
plugin table with no ``permissions`` block is invisible to this layer.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Depends

from ..dependencies import require_crud_permission
from ..migrations.plugin_migrations import parse_plugin_tables_from_manifest
from ..models.base import Base
from ..models.plugin_route import RouteDefinition, parse_plugin_routes_from_manifest
from ..models.plugin_table import PluginTableDefinition
from ..permissions import PermissionsRegistry, build_permissions_registry
from ..plugins import discover_plugin_manifests
from .crud_handlers import HANDLER_FACTORIES, SUCCESS_STATUS, user_columns_from_model

logger = Logger()

#: Builds the per-route authorization dependency: ``(table, operation, registry)``
#: -> a FastAPI dependency. Both ``require_crud_permission`` and
#: ``require_principal_crud_permission`` satisfy it; they authorise on the same
#: axis and differ only in which transport they accept.
GuardFactory = Callable[[str, str, PermissionsRegistry], Callable[..., Awaitable[None]]]


class PluginTableCollisionError(ValueError):
    """A plugin manifest declares a table name that already belongs to
    something else on the shared ``Base.metadata`` — a hand-written Core
    model, or a table another already-processed plugin has claimed
    (tabsii-platform#850 / biffo-template#1459).

    Without this check the collision surfaces in one of two ways, neither of
    them acceptable:

    - **Against a Core table**: ``PluginTableDefinition.to_sqlalchemy_model()``
      declares a second SQLAlchemy class with the same ``__tablename__``,
      which raises a raw ``sqlalchemy.exc.InvalidRequestError`` deep inside
      declarative class construction — no plugin name, no actionable
      guidance, and (because ``build_plugin_router()`` runs at Core API
      import time) it can take down collection of every unrelated test
      module that imports ``api.main``, exactly as it did in production.
    - **Against another plugin's table**: ``_model_cache`` below is keyed
      only by table name (deliberately, so the *same* plugin can be
      reprocessed across repeat ``build_plugin_router()`` calls — main.py
      makes two, one per mount). A second, unrelated plugin declaring the
      same table name would silently receive the first plugin's cached
      model — no error at all, just one plugin's CRUD routes quietly
      operating on another plugin's schema.

    Raising this — caught by ``build_plugin_router()``'s existing
    "one broken plugin must not take down every other plugin" handling —
    turns both shapes into the same outcome: the colliding plugin's routes
    are skipped (fail closed, default-deny), every other plugin and Core
    itself boot normally, and the log names the plugin, the table, and what
    already owns it.
    """


# SQLAlchemy model classes, keyed by table name.
# PluginTableDefinition.to_sqlalchemy_model() creates a brand-new mapped
# class (and registers its Table with the shared Base.metadata) on every
# call; calling it twice for the same table name raises "Table already
# defined for this MetaData instance". build_plugin_router() can legitimately
# be called more than once in the same process (e.g. once per test, or if a
# future hot-reload path calls it again), so model classes are memoized here
# rather than rebuilt on every call.
_model_cache: dict[str, type[Any]] = {}

# Which plugin claimed each cached table name — lets a repeat
# build_plugin_router() call for the SAME plugin reuse its cached model
# (see _model_cache's docstring) while a DIFFERENT plugin declaring the same
# table name is caught as a collision (PluginTableCollisionError) instead of
# silently being handed the first plugin's model.
_model_owner: dict[str, str] = {}


def _get_model(table_def: PluginTableDefinition, plugin_name: str) -> type[Any]:
    owner = _model_owner.get(table_def.name)
    if owner is not None:
        if owner != plugin_name:
            raise PluginTableCollisionError(
                f"Plugin {plugin_name!r} declares table {table_def.name!r}, which is "
                f"already owned by plugin {owner!r}. Plugin table names must be unique "
                f"across Core and every installed plugin — rename the table in "
                f"{plugin_name}'s biffo.plugin.json."
            )
        return _model_cache[table_def.name]

    if table_def.name in Base.metadata.tables:
        raise PluginTableCollisionError(
            f"Plugin {plugin_name!r} declares table {table_def.name!r}, which collides "
            f"with an existing Core table of the same name. Plugin table names must be "
            f"unique across Core and every installed plugin — rename the table in "
            f"{plugin_name}'s biffo.plugin.json."
        )

    model = table_def.to_sqlalchemy_model()
    _model_cache[table_def.name] = model
    _model_owner[table_def.name] = plugin_name
    return model


def build_plugin_router(
    manifests: Sequence[dict[str, Any]] | None = None,
    *,
    permissions_registry: PermissionsRegistry | None = None,
    path_prefix: str = "/plugins",
    guard_factory: GuardFactory = require_crud_permission,
) -> APIRouter:
    """Build one APIRouter covering every installed plugin's declared routes.

    Args:
        manifests: Manifest dicts to build routes from. Defaults to
            ``discover_plugin_manifests()`` (every installed plugin found on
            disk). Tests pass an explicit list so they don't depend on real
            ``services/*/biffo.plugin.json`` files existing.
        permissions_registry: The registry the ADR-0004 authorization guards
            resolve against. Defaults to one built from the *same* manifests, so
            a route and its permission check never diverge. Passed explicitly
            only when a caller needs routes and permissions to come from
            different sources (not the normal case).
        path_prefix: The segment the per-plugin routers hang off. The default
            ``/plugins`` is the public, Cognito-facing mount. ``main.py`` builds
            a *second* router at ``/internal/plugins`` because API Gateway sends
            all of ``/api/v1/plugins/*`` to the shared plugin host (ADR-0021), so
            Core's own copy of these routes is unaddressable from outside — the
            #652 collision. ``/api/v1/internal/*`` is IAM-authorized and does
            reach Core, giving the host a path to forward to.
        guard_factory: Builds the per-route authorization dependency. Defaults
            to the bearer-only ``require_crud_permission``; the internal mount
            passes ``require_principal_crud_permission``, which accepts the same
            user token from either transport and authorises on the same axis.
            The two mounts therefore differ in *who can reach them*, never in
            what is allowed once they do.

    Returns:
        An APIRouter with no prefix of its own — the caller (main.py)
        mounts it at "/api/v1", so a route declared with path "/widgets" in
        plugin "gizmos" ends up at "/api/v1/plugins/gizmos/widgets".

    A plugin whose manifest fails route/table parsing (an invalid
    RouteDefinition, or a route referencing a table the manifest doesn't
    declare), OR whose declared table name collides with an existing Core
    table or another plugin's table (PluginTableCollisionError — see its
    docstring), has its routes skipped entirely, with a warning logged —
    this matches discover_plugin_manifests' policy that one broken plugin
    must not prevent every other plugin (or the Core API itself) from
    starting.
    """
    router = APIRouter()
    discovered = discover_plugin_manifests() if manifests is None else manifests
    registry = (
        permissions_registry
        if permissions_registry is not None
        else build_permissions_registry(discovered, core_models=[])
    )

    for manifest in discovered:
        name = manifest.get("name")
        if not name:
            logger.warning("Skipping plugin manifest with no 'name'; cannot mount routes.")
            continue

        try:
            tables = {t.name: t for t in parse_plugin_tables_from_manifest(manifest)}
            routes: list[RouteDefinition] = parse_plugin_routes_from_manifest(manifest)

            if not routes:
                continue

            plugin_router = APIRouter(prefix=f"{path_prefix}/{name}", tags=[f"plugin:{name}"])
            for route in routes:
                table_def = tables[route.table]
                model = _get_model(table_def, name)
                user_columns = user_columns_from_model(model)
                handler = HANDLER_FACTORIES[route.operation](model, user_columns)
                plugin_router.add_api_route(
                    route.path,
                    handler,
                    methods=[route.method],
                    status_code=SUCCESS_STATUS[route.operation],
                    summary=route.description or f"{route.operation} {route.table}",
                    dependencies=[Depends(guard_factory(route.table, route.operation, registry))],
                )
        except (ValueError, TypeError) as exc:
            logger.warning(f"Skipping routes for plugin {name!r}: invalid manifest: {exc}")
            continue

        router.include_router(plugin_router)

    return router
