"""Plugin route (API endpoint) declaration models for dynamic route registration.

``RouteDefinition`` is mirrored in
``packages/python-sdk/src/biffo_plugin_sdk/plugin.py``'s ``RouteDef`` for
external plugin authors (that package can't import this module — see
``plugin_table.py``'s docstring for why). If either side's fields, defaults,
or validators change, update the other.

Design note (issue #19 / ADR-0002 / ADR-0004): a plugin manifest cannot ship
executable route-handler code that the Core API imports and runs — that would
grant a plugin arbitrary code execution inside the Core API process, which
ADR-0002 explicitly forbids (plugins talk to the Core API over HTTP; they are
not linked into its process). So a route's "handler" is not code. It is a
declaration of which of the plugin's own tables (from the same manifest's
``tables``) the route exposes, and which generic CRUD operation (using the
same list/read/create/update/delete vocabulary ADR-0004 defines for its
permissions registry) the Core API should synthesize for it. See
``api.routing.plugin_router`` for the code that turns a validated
``RouteDefinition`` into an actual FastAPI endpoint.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

# Operation -> the HTTP method(s) it's allowed to use.
_OPERATION_METHODS: dict[str, frozenset[str]] = {
    "list": frozenset({"GET"}),
    "read": frozenset({"GET"}),
    "create": frozenset({"POST"}),
    "update": frozenset({"PUT", "PATCH"}),
    "delete": frozenset({"DELETE"}),
}

# Operations that address a single row need an {id} path parameter; the
# collection-level operations (list, create) must not have one.
_SINGLE_ROW_OPERATIONS: frozenset[str] = frozenset({"read", "update", "delete"})


class RouteDefinition(BaseModel):
    """Declares one plugin API route, mounted under
    ``/api/v1/plugins/<plugin-name>/<path>`` (see
    ``api.routing.plugin_router.build_plugin_router``).
    """

    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
    path: str = Field(
        description="Path relative to the plugin's mount point "
        "(/api/v1/plugins/<name>), e.g. '/widgets' or '/widgets/{id}'. "
        "Must start with '/'."
    )
    table: str = Field(
        description="Name of a table declared in this manifest's `tables`."
    )
    operation: Literal["list", "read", "create", "update", "delete"] = Field(
        description="Generic CRUD operation the Core API synthesizes for "
        "this route against `table`, scoped to the caller's tenant_id "
        "(ADR-0001)."
    )
    description: str = ""

    @model_validator(mode="after")
    def _validate_method_and_path(self) -> "RouteDefinition":
        if not self.path.startswith("/"):
            raise ValueError(f"path must start with '/': {self.path!r}")

        allowed_methods = _OPERATION_METHODS[self.operation]
        if self.method not in allowed_methods:
            raise ValueError(
                f"operation '{self.operation}' requires method in "
                f"{sorted(allowed_methods)}, got {self.method!r}"
            )

        has_id = "{id}" in self.path
        needs_id = self.operation in _SINGLE_ROW_OPERATIONS
        if needs_id and not has_id:
            raise ValueError(
                f"operation '{self.operation}' addresses a single row and "
                f"requires an '{{id}}' path parameter: {self.path!r}"
            )
        if not needs_id and has_id:
            raise ValueError(
                f"operation '{self.operation}' is collection-level and must "
                f"not have an '{{id}}' path parameter: {self.path!r}"
            )
        return self


def parse_plugin_routes_from_manifest(
    manifest: dict[str, Any],
) -> list[RouteDefinition]:
    """Parse and cross-validate route declarations from a plugin manifest dict.

    Every route's ``table`` must match the ``name`` of one of the manifest's
    own ``tables`` entries — a route cannot reference another plugin's table,
    and a manifest can't declare a route for a table it doesn't also declare.
    Raises ``ValueError`` for that cross-field check (not a Pydantic
    ``ValidationError``, since it spans two top-level manifest keys rather
    than being expressible as a single model's own validator), consistent
    with how ``plugin_migrations.py``'s manifest-level checks are surfaced.

    Args:
        manifest: The parsed plugin manifest JSON, containing (optionally)
            an 'api_routes' key and a 'tables' key.

    Returns:
        List of RouteDefinition instances, in manifest order. Empty if the
        manifest declares no routes.
    """
    routes_data = manifest.get("api_routes", [])
    if not routes_data:
        return []

    table_names = {
        t["name"] if isinstance(t, dict) else t.name for t in manifest.get("tables", [])
    }

    routes: list[RouteDefinition] = []
    seen: set[tuple[str, str]] = set()
    for route_data in routes_data:
        route = RouteDefinition(**route_data)
        if route.table not in table_names:
            raise ValueError(
                f"Route {route.method} {route.path} references table "
                f"{route.table!r}, which is not declared in this manifest's "
                f"'tables' ({sorted(table_names)})."
            )
        key = (route.method, route.path)
        if key in seen:
            raise ValueError(
                f"Duplicate route declaration: {route.method} {route.path}"
            )
        seen.add(key)
        routes.append(route)
    return routes
