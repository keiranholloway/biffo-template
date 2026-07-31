"""One authorization model, not two route families (#621, step 3).

Core has two *transports* for an authenticated request — a browser's
``Authorization: Bearer`` and a SigV4-signed service call carrying the user's
token in ``X-Biffo-User-Token``. That much is forced by AWS. What was not forced
was the second **authorization stack** that grew around the second transport, and
the two duplicates drifted: the ``is_active`` deactivation gate (#150) was
enforced on one and silently missing from the other for the whole of a suspended
user's remaining token lifetime.

The fix was structural — one ``Principal``, resolved by ``require_principal``,
whichever header carried the token. These guards keep it structural. Left to
convention it will drift again: a new internal route only has to reach for the
retired dependency, or a plugin author only has to copy the old handler
signature, and the two stacks are back.

Both guards are deliberately **not** greps. A textual search for
``require_forwarded_user`` matches its own definition, every docstring that
explains the history, and this module's own prose, so it fires on its own fix
and cannot be left in the suite. The first guard walks the API package's ASTs,
where a name in a comment or a docstring simply is not a reference; the second
walks FastAPI's *resolved* dependency graph, which is the thing that actually
decides who may reach a route.
"""

from __future__ import annotations

import ast
import copy
from pathlib import Path

from api.middleware.principal import require_principal
from api.routers import internal_agent_chat
from api.routing.owner_data_router import build_owner_data_router
from fastapi import FastAPI
from fastapi.dependencies.models import Dependant
from fastapi.dependencies.utils import get_dependant
from fastapi.routing import APIRoute

#: The retired dependency. Its user-identity resolution now lives in
#: ``middleware/principal.require_principal``; only the header *constant*
#: survives in ``middleware/forwarded_user``.
RETIRED = "require_forwarded_user"

#: The single dependency every authenticated route resolves its caller through
#: on the forwarded transport.
UNIFIED = "api.middleware.principal.require_principal"

_API_SRC = Path(__file__).resolve().parents[1] / "src" / "api"


# ── guard 1: nothing in the API package references the retired dependency ───────


def _references(tree: ast.AST) -> bool:
    """Whether this module *uses* the retired name, in the syntactic sense.

    Counts a ``from … import require_forwarded_user``, a bare ``Name`` use, an
    attribute access (``forwarded_user.require_forwarded_user``) and a
    definition of that name. Deliberately does not count string literals: a
    docstring recounting the #621 history is not a dependency, and a guard that
    could not tell the difference would have to be deleted the first time
    someone documented the model it protects.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if any(alias.name == RETIRED for alias in node.names):
                return True
        elif isinstance(node, ast.Name) and node.id == RETIRED:
            return True
        elif isinstance(node, ast.Attribute) and node.attr == RETIRED:
            return True
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == RETIRED:
            return True
    return False


def test_no_module_in_the_api_package_references_the_retired_dependency():
    """Including its own former home: the function is gone, not merely unused.

    A surviving definition is an invitation — the next internal route imports it,
    gets the unwrapped identity, and the deactivation gate is optional again.
    """
    offenders = sorted(
        str(path.relative_to(_API_SRC))
        for path in _API_SRC.rglob("*.py")
        if _references(ast.parse(path.read_text(encoding="utf-8")))
    )

    assert offenders == [], (
        f"{RETIRED} is referenced by {offenders}. Core authenticates one principal; "
        f"depend on require_principal (and require_signed_principal for the "
        f"service-borne routes) instead of reviving the second stack."
    )


# ── guard 2: the resolved dependency graph of the routes themselves ─────────────


def _qualified(call: object) -> str:
    return f"{getattr(call, '__module__', '')}.{getattr(call, '__qualname__', call)}"


def _names_under(dependant: Dependant) -> set[str]:
    """Every callable in this dependant's tree, transitively."""
    names: set[str] = set()
    stack = [dependant]
    while stack:
        node = stack.pop()
        if node.call is not None:
            names.add(_qualified(node.call))
        stack.extend(node.dependencies)
    return names


def _routes_with_dependencies(node: object, ambient: frozenset[str] = frozenset()):
    """Yield ``(route, dependency names)`` for every API route reachable from
    ``node``, descending through included routers and sub-applications.

    FastAPI 0.138 includes a router **lazily**: ``app.routes`` holds an opaque
    wrapper, and the real ``APIRoute`` objects live on its ``original_router``.
    A walk of ``app.routes`` alone therefore finds nothing at all and every
    assertion below would pass vacuously — which is what the third test exists
    to notice.

    ``ambient`` carries dependencies attached at *include* time
    (``include_router(..., dependencies=[...])``). They gate the routes without
    appearing in any handler signature, so a guard that ignored them could be
    satisfied by a route family that was still gated the old way one level up.
    """
    for route in getattr(node, "routes", []):
        if isinstance(route, APIRoute):
            yield route, ambient | _names_under(route.dependant)
            continue

        nested = getattr(route, "original_router", None)
        context = getattr(route, "include_context", None)
        extra = set(ambient)
        for depends in getattr(context, "dependencies", None) or []:
            call = getattr(depends, "dependency", None)
            if call is not None:
                extra |= _names_under(get_dependant(path="", call=call))
        if nested is None and hasattr(route, "routes") and route is not node:
            nested = route
        if nested is not None:
            yield from _routes_with_dependencies(nested, frozenset(extra))


_GUARD_MANIFEST = {
    "name": "authz-guard",
    "tables": [
        {
            # A name of this guard's own, so building the router here never
            # collides with another test's dynamic model on Base.metadata.
            "name": "authz_guard_widgets",
            "columns": [
                {"name": "owner_sub", "type": "String(64)", "nullable": False},
                {"name": "label", "type": "String(200)", "nullable": True},
            ],
            "permissions": {},
            "owner_scoped_service": {
                "owner_column": "owner_sub",
                "allowed_principals": ["system:authz-guard"],
            },
        }
    ],
}


def _service_borne_routes() -> list[tuple[APIRoute, frozenset[str]]]:
    """The route families that take the user's token from the forwarded header.

    The owner-scoped data routes exist only for a plugin table that opts in, and
    the base template ships no such manifest, so they are built here from a
    synthetic one rather than read off the deployed app.
    """
    app = FastAPI()
    app.include_router(internal_agent_chat.router, prefix="/api/v1")
    app.include_router(build_owner_data_router(manifests=[copy.deepcopy(_GUARD_MANIFEST)]))
    return list(_routes_with_dependencies(app))


def test_every_service_borne_route_resolves_its_caller_through_require_principal():
    """The positive half: these routes have not merely stopped using the retired
    dependency, they use the unified one — so ``is_active``, platform-admin sync
    and permission resolution are reached by construction, not by remembering."""
    routes = _service_borne_routes()
    assert len(routes) == 5, f"expected the chat route and four owner-data routes, got {routes}"

    missing = sorted(route.path for route, names in routes if UNIFIED not in names)
    assert missing == [], f"routes not resolving their caller via {UNIFIED}: {missing}"


def test_no_route_anywhere_depends_on_the_retired_dependency():
    """Every route the deployment actually mounts, plus the manifest-built
    families that only appear when a plugin opts in."""
    from api.main import app

    routes = list(_routes_with_dependencies(app)) + _service_borne_routes()

    offenders = sorted(
        route.path
        for route, names in routes
        if any(name.rsplit(".", 1)[-1] == RETIRED for name in names)
    )
    assert offenders == [], f"routes still depending on {RETIRED}: {offenders}"


def test_the_guard_walk_is_not_vacuous():
    """The assertions above are absence proofs, so they are only worth anything
    if the walk can find a dependency that IS there. It reaches into lazily
    included routers (where a naive ``app.routes`` scan finds zero routes) and
    names callables the same way the offender check does."""
    assert _qualified(require_principal) == UNIFIED

    deployed = list(_routes_with_dependencies(__import__("api.main", fromlist=["app"]).app))
    assert len(deployed) > 10, f"only {len(deployed)} routes found on the deployed app"
    assert any("api.middleware.auth.require_auth" in names for _, names in deployed)
