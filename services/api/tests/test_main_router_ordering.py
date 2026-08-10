"""Regression guard for issue #668: ``main.py``'s router include *order* is
load-bearing, and nothing used to test it.

The defect
----------
Building the domain router is what *imports* each ``api.domains.<name>``
package, and importing a domain is what puts its models on
``TenantScopedModel.__subclasses__()``. ``_iter_core_crud_models()``
(permissions.py) only ever sees classes that have already been imported. So
while ``main.py`` built the generic-CRUD router *first*, a relocated product
domain's opted-in tables were invisible to it and **every**
``/api/v1/data/<table>`` route they back silently vanished — 21 of them in
tabsii-platform#207, with the full suite green (1712 passed).

Why the whole suite could stay green
------------------------------------
Every other test imports the models it needs directly, at module scope, so
registration always happens *before* the assertion. Nothing assembled the
route surface the way ``main.py`` does and then looked at what came out. That
is the gap these tests close: the synthetic domain below defines its model as a
**side effect of being imported**, inside the fake ``import_module``, exactly as
a real domain package does — so the timing that produced the bug is reproduced
rather than assumed away.

The two invariants asserted here
--------------------------------
1. **Domains are included before generic CRUD.** The order is read out of
   ``main.py``'s own source (AST), not hardcoded, so reverting the include order
   fails these tests instead of quietly re-arming the trap.
2. **No route shadows another on the same (path, method).** Mounting domains
   first is only safe because Starlette keeps looking past a *method*-mismatched
   route: a domain may hand-write ``POST /data/brands`` while generic CRUD
   serves ``GET /data/brands``. That works only while no domain claims a
   (path, method) pair generic CRUD also claims — an invariant worth asserting
   rather than assuming, since violating it makes the CRUD route unreachable
   just as silently as the original bug.
"""

from __future__ import annotations

import ast
import importlib
from collections import Counter
from collections.abc import Callable, Iterable, Iterator, Sequence
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from api import main as api_main
from api.models.base import TenantScopedModel
from api.routing import domain_router
from api.routing.core_crud_router import build_core_crud_router
from api.routing.domain_router import build_domain_router
from fastapi import APIRouter, FastAPI

# The two module-level builder calls whose relative order is the subject of
# #668. Keyed by the name as it appears in main.py's source, so the AST read
# below can map a call site back to the callable.
_BUILDERS: dict[str, Callable[[], APIRouter]] = {
    "build_domain_router": build_domain_router,
    "build_core_crud_router": build_core_crud_router,
}

_DOMAIN_NAME = "synthetic"


def _mains_include_order() -> list[str]:
    """The order in which ``main.py`` actually calls the two builders.

    Read from main.py's source rather than hardcoded: a test that asserted a
    fixed order would pass no matter what main.py does, which is exactly the
    class of test that let #668 ship.
    """
    tree = ast.parse(Path(api_main.__file__).read_text(encoding="utf-8"))
    calls = [
        (node.lineno, node.func.id)
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in _BUILDERS
    ]
    assert sorted(name for _, name in calls) == sorted(_BUILDERS), (
        f"expected main.py to call each of {sorted(_BUILDERS)} exactly once at "
        f"module level; found {calls}"
    )
    return [name for _, name in sorted(calls)]


def _synthetic_domain(table: str, *, hand_written_method: str = "POST") -> SimpleNamespace:
    """Stand-in for a real ``api.domains.<name>`` package (ADR-0022).

    The model is defined **here**, when the domain is "imported" — not at module
    scope — because the timing *is* the bug. A module-scope model would be on
    ``TenantScopedModel.__subclasses__()`` before either router was built, and
    both include orders would look identical.

    ``hand_written_method`` is the method of the domain's own hand-written route
    on the same ``/data/<table>`` path generic CRUD serves. ``POST`` is the real
    tabsii shape (hand-written create + generic list/read) and must coexist;
    ``GET`` is the collision the second invariant forbids.
    """

    # Built with type() rather than a `class` statement purely so each call gets
    # a distinct class *name*: SQLAlchemy's declarative string-lookup table is
    # keyed on module + class name, and re-declaring `Widget` per test would
    # warn about replacing its predecessor. No mapped columns beyond the ones
    # TenantScopedModel already provides — the tests inspect the route surface,
    # never a row.
    model = type(
        f"Widget_{table}",
        (TenantScopedModel,),
        {
            "__tablename__": table,
            "__crud_permissions__": {
                "list": {"allowed": True},
                "read": {"allowed": True},
            },
        },
    )
    assert model.__tablename__ == table  # the domain's model now exists

    hand_written = APIRouter()
    hand_written.add_api_route(
        f"/data/{table}",
        lambda: {"domain": _DOMAIN_NAME},
        methods=[hand_written_method],
    )
    return SimpleNamespace(routers=[hand_written])


def _assemble(
    order: Sequence[str],
    table: str,
    monkeypatch: pytest.MonkeyPatch,
    *,
    hand_written_method: str = "POST",
) -> FastAPI:
    """Build an app by including the two routers in ``order``, with one
    synthetic product domain present — i.e. the way ``main.py`` assembles the
    real app, minus the routers irrelevant to this invariant."""
    real_import = importlib.import_module

    def _fake_import(name: str, *args: Any, **kwargs: Any) -> Any:
        if name.endswith(f".domains.{_DOMAIN_NAME}"):
            return _synthetic_domain(table, hand_written_method=hand_written_method)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(domain_router, "_discover_domain_names", lambda: [_DOMAIN_NAME])
    monkeypatch.setattr(importlib, "import_module", _fake_import)

    app = FastAPI()
    for name in order:
        app.include_router(_BUILDERS[name](), prefix="/api/v1")
    return app


def _walk_routes(routes: Iterable[Any], prefix: str = "") -> Iterator[tuple[str, str]]:
    """Every ``(path, method)`` the app actually serves, mount prefixes applied.

    ``app.routes`` is **not** a flat list. Since FastAPI 0.13x an
    ``include_router()`` leaves an ``_IncludedRouter`` placeholder holding the
    original router plus its mount prefix, and resolves it at request time — so
    a naive ``[r.path for r in app.routes]`` sees four ``/docs``-ish routes and
    a handful of opaque placeholders, and any assertion built on it passes
    because it can see nothing (which is how this test was first written, and
    is the same fail-open shape as the bug it guards).
    ``test_the_route_walker_can_actually_see_the_real_apps_surface`` below keeps
    that honest by checking this walker against the app's own OpenAPI document.
    """
    for route in routes:
        context = getattr(route, "include_context", None)
        if context is not None:
            yield from _walk_routes(context.included_router.routes, prefix + (context.prefix or ""))
            continue
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None)
        if path is None or not methods:
            continue
        for method in methods:
            yield (prefix + path, method)


def _route_keys(app: FastAPI) -> list[tuple[str, str]]:
    return list(_walk_routes(app.routes))


def _duplicates(keys: Iterable[tuple[str, str]]) -> list[tuple[str, str]]:
    return sorted(key for key, count in Counter(keys).items() if count > 1)


def test_the_route_walker_can_actually_see_the_real_apps_surface() -> None:
    """Fail-open guard for the walker itself: everything the real app publishes
    in its OpenAPI document must also be visible to ``_walk_routes``. Without
    this, a FastAPI change to how included routers are stored would turn every
    assertion below into a green no-op."""
    spec = api_main.app.openapi()
    published = {(path, method.upper()) for path, ops in spec["paths"].items() for method in ops}
    assert published, "the real app publishes no paths at all — check the fixture"
    assert not published - set(_route_keys(api_main.app))


# --------------------------------------------------------------------------
# Invariant 1: domains are included before generic CRUD (#668)
# --------------------------------------------------------------------------


def test_domains_opt_in_tables_reach_generic_crud_under_mains_real_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The route surface main.py's own ordering actually produces.

    Fails on the pre-#668 order (generic CRUD first), where the domain's models
    are not yet imported when ``_iter_core_crud_models()`` walks the subclass
    tree, so its ``/data/<table>`` routes are never mounted at all.
    """
    table = "test_ordering_widgets"
    app = _assemble(_mains_include_order(), table, monkeypatch)
    keys = set(_route_keys(app))

    assert (f"/api/v1/data/{table}", "GET") in keys, (
        f"generic CRUD did not mount /api/v1/data/{table} — main.py includes "
        f"{_mains_include_order()[0]} first, so a product domain's models are "
        "imported too late for _iter_core_crud_models() to discover them "
        "(issue #668). Include build_domain_router() before "
        "build_core_crud_router()."
    )
    assert (f"/api/v1/data/{table}/{{id}}", "GET") in keys


def test_hand_written_domain_route_and_generic_crud_share_a_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The real tabsii shape: the domain hand-writes ``POST /data/<table>``
    while generic CRUD serves ``GET`` on the same path. Both must be present —
    this is what "mount domains first" is allowed to do, and it works only
    because Starlette keeps looking past a method-mismatched route."""
    table = "test_coexist_widgets"
    keys = set(_route_keys(_assemble(_mains_include_order(), table, monkeypatch)))
    assert (f"/api/v1/data/{table}", "POST") in keys
    assert (f"/api/v1/data/{table}", "GET") in keys


def test_the_pre_fix_order_really_does_lose_the_routes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Proof the guard above is not vacuous: run the *old* order deliberately
    and watch the same domain's generic-CRUD routes disappear.

    Each test here uses its own table name and its own freshly-defined model
    class, created inside the fake import — so no test can mask another by
    having already registered the model under test.
    """
    table = "test_prefix_order_widgets"
    app = _assemble(["build_core_crud_router", "build_domain_router"], table, monkeypatch)
    keys = set(_route_keys(app))

    assert (f"/api/v1/data/{table}", "POST") in keys  # the domain's own route survives
    assert (f"/api/v1/data/{table}", "GET") not in keys  # ...but generic CRUD is gone


# --------------------------------------------------------------------------
# Invariant 2: no route shadows another on the same (path, method)
# --------------------------------------------------------------------------


#: Pairs where a second registration is DELIBERATE and documented, so the
#: first-mounted route winning is the intent rather than an accident.
#:
#: ``routers/whoami.py`` is registered LAST in ``main.py`` precisely so that an
#: instance serving a richer ``/whoami`` from a product domain wins the path —
#: its own module docstring says "this never runs" in that case. The core copy
#: exists because the template-owned portal login page calls the endpoint on
#: every sign-in, and instances without a product implementation were serving a
#: 404 that looked exactly like a rejected password.
#:
#: Upstream that pair never collides, because the template has no product
#: domain to shadow it. It collides in EVERY instance that has one — so the
#: guard and the thing it guards disagreed, and only downstream could tell.
_INTENTIONAL_SHADOWS: frozenset[tuple[str, str]] = frozenset({("/api/v1/whoami", "GET")})


def test_no_two_routes_claim_the_same_path_and_method() -> None:
    """Mounting domains first is safe only while no domain claims a
    (path, method) pair generic CRUD also claims. Asserted against the real
    assembled app, so an instance that adds such a domain fails here instead of
    losing a CRUD route in production.

    ``_INTENTIONAL_SHADOWS`` is subtracted rather than the assertion being
    softened: an undocumented duplicate still fails, and adding a new exemption
    is a deliberate edit with a reason attached."""
    duplicates = [
        k for k in _duplicates(_route_keys(api_main.app)) if k not in _INTENTIONAL_SHADOWS
    ]
    assert not duplicates, (
        "these (path, method) pairs are claimed by more than one route, so only "
        f"the first-mounted one is reachable: {duplicates}. Domains are mounted "
        "before generic CRUD (#668), so a domain route wins — rename the domain "
        "route or turn the colliding CRUD operation off in __crud_permissions__."
    )


def test_the_collision_guard_detects_a_domain_shadowing_generic_crud(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Proof the check above can fail: a domain hand-writing ``GET`` on a path
    generic CRUD also serves with ``GET`` is a real collision, and is
    detected."""
    table = "test_collision_widgets"
    app = _assemble(_mains_include_order(), table, monkeypatch, hand_written_method="GET")
    assert _duplicates(_route_keys(app)) == [(f"/api/v1/data/{table}", "GET")]


def test_the_intentional_shadow_exemption_is_narrow() -> None:
    """The exemption must not become a blanket hole.

    Every pair in ``_INTENTIONAL_SHADOWS`` has to be a real route the assembled
    app actually serves — an entry naming a path that no longer exists is dead
    permission, and would silently keep excusing a future collision on a path
    that came to mean something else.
    """
    live = set(_route_keys(api_main.app))
    stale = sorted(pair for pair in _INTENTIONAL_SHADOWS if pair not in live)
    assert not stale, (
        f"these exemptions name routes the app does not serve: {stale}. "
        "Remove them — an exemption for a path that no longer exists excuses a "
        "collision nobody has reasoned about."
    )
