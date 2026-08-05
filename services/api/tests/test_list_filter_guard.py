"""No list handler may accept a query parameter it will not honour.

The same defect has now been fixed twice: the tenant-scoped generic list route
took no query parameters at all and discarded every filter sent over HTTP
(tabsii-crm#239), and the owner-scoped one had an ``if key in user_columns``
with no ``else``, so an unrecognised parameter was silently ignored and answered
with a 200 (tabsii-platform#665). Both were found by someone reading the code,
months apart, and the second was written *after* a prose warning about the first
had been added to a router docstring.

A prose warning is a second copy of a decision, and this estate has watched that
fail before: `fdds.py` documented the rule and three more routers did the
forbidden thing anyway, and `_extract_detail` was written twice in two siblings
because the second author had no way to discover the first. So this file is the
guard that makes instance three fail CI instead.

It asserts three things about ``src/api/routing/``:

1. **Behavioural, convention-independent** — any function that reads
   ``request.query_params`` must route the result through the shared
   ``apply_list_filters`` (directly or via ``build_list_query``). A handler that
   grows its own ``for key, value in ...`` loop fails here regardless of what it
   is called.
2. **Shape** — ``query_params`` may only be read via ``.multi_items()``.
   ``.items()`` collapses a repeated parameter to its last occurrence, silently
   choosing between two things the caller asked for.
3. **Registry** — every ``make_*list*handler`` factory routes through the shared
   helper, so a factory that reads no query parameters at all (the tabsii-crm#239
   shape, where FastAPI accepts the query string and nothing ever looks at it)
   is caught too.

It walks the AST rather than grepping, for the reason a compliance guard usually
has to: a grep for ``query_params.items()`` matches its own rule text and every
test that mentions it, so it fires on its own fix. And every scan asserts it
found something first — a guard whose discovery silently returns an empty set
passes for the worst possible reason.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

ROUTING_DIR = Path(__file__).resolve().parents[1] / "src" / "api" / "routing"

# The shared rejection/coercion path. `build_list_query` is a thin wrapper that
# delegates to `apply_list_filters`, so either satisfies the rule.
SHARED_FILTER_HELPERS = frozenset({"apply_list_filters", "build_list_query"})


def _routing_modules() -> list[tuple[Path, ast.Module]]:
    modules = [
        (path, ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))
        for path in sorted(ROUTING_DIR.glob("*.py"))
    ]
    assert modules, f"no routing modules found under {ROUTING_DIR} — the scan is broken"
    return modules


def _called_names(node: ast.AST) -> set[str]:
    """Every function name called anywhere inside ``node``, including nested
    functions — a factory's real work is in the closure it returns."""
    names: set[str] = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Call):
            func = child.func
            if isinstance(func, ast.Name):
                names.add(func.id)
            elif isinstance(func, ast.Attribute):
                names.add(func.attr)
    return names


def _top_level_functions(module: ast.Module) -> list[ast.FunctionDef | ast.AsyncFunctionDef]:
    return [n for n in module.body if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef)]


def _query_param_reads(node: ast.AST) -> list[ast.Attribute]:
    return [
        child
        for child in ast.walk(node)
        if isinstance(child, ast.Attribute) and child.attr == "query_params"
    ]


def _is_list_handler_factory(name: str) -> bool:
    return name.startswith("make_") and "list" in name and name.endswith("handler")


def test_every_function_that_reads_query_params_routes_them_through_the_shared_helper():
    """The rule that does not depend on what anything is named: if you looked at
    the query string, you must hand it to the thing that decides which
    parameters are honourable and rejects the rest."""
    checked = 0
    offenders: list[str] = []
    for path, module in _routing_modules():
        for func in _top_level_functions(module):
            if not _query_param_reads(func):
                continue
            checked += 1
            if not (_called_names(func) & SHARED_FILTER_HELPERS):
                offenders.append(f"{path.name}::{func.name}")

    assert checked >= 2, (
        "expected at least the tenant-scoped and owner-scoped list handlers to "
        f"read query params; found {checked}. Either the scan is broken or a "
        "handler stopped reading them, which is the tabsii-crm#239 shape."
    )
    assert not offenders, (
        "these read request.query_params without routing them through "
        f"{sorted(SHARED_FILTER_HELPERS)}: {offenders}. A filter this layer "
        "accepts and drops is a silent wrong answer with a 200 — the defect "
        "fixed in tabsii-crm#239 and again in tabsii-platform#665."
    )


def test_query_params_are_only_ever_read_by_multi_items():
    """``.items()`` collapses ``?a=1&a=2`` to its last occurrence, choosing
    between two things the caller asked for without saying so. The shared helper
    can only reject a repeat it can see, so the raw read has to preserve it."""
    reads = 0
    offenders: list[str] = []
    for path, module in _routing_modules():
        parents: dict[ast.AST, ast.AST] = {}
        for node in ast.walk(module):
            for child in ast.iter_child_nodes(node):
                parents[child] = node
        for read in _query_param_reads(module):
            reads += 1
            parent = parents.get(read)
            if not (isinstance(parent, ast.Attribute) and parent.attr == "multi_items"):
                shape = parent.attr if isinstance(parent, ast.Attribute) else type(parent).__name__
                offenders.append(f"{path.name}: query_params.{shape}")

    assert reads >= 2, f"expected at least 2 query_params reads in routing/; found {reads}"
    assert not offenders, (
        f"query_params must be read via .multi_items(): {offenders}. Anything "
        "else silently collapses a repeated parameter to its last occurrence."
    )


def test_every_list_handler_factory_routes_through_the_shared_helper():
    """The registry half. A factory that reads no query parameters at all still
    mounts a route FastAPI will happily accept a query string on — which is
    exactly how tabsii-crm#239 shipped — so "reads none" is not a pass."""
    factories = [
        (path, func)
        for path, module in _routing_modules()
        for func in _top_level_functions(module)
        if _is_list_handler_factory(func.name)
    ]

    assert len(factories) >= 2, (
        "expected at least make_list_handler and make_owner_list_handler; found "
        f"{[f.name for _, f in factories]}. A discovery that finds nothing "
        "passes every assertion below it for the worst possible reason."
    )

    offenders = [
        f"{path.name}::{func.name}"
        for path, func in factories
        if not (_called_names(func) & SHARED_FILTER_HELPERS)
    ]
    assert not offenders, (
        f"these list handler factories do not use {sorted(SHARED_FILTER_HELPERS)}: "
        f"{offenders}. Two list handlers deciding independently what an unknown "
        "parameter is worth is how the same defect got fixed twice."
    )


@pytest.mark.parametrize(
    "source",
    [
        # The tabsii-platform#665 shape: an `if key in ...` with no `else`.
        "def make_thing_list_handler(model):\n"
        "    async def handler(request):\n"
        "        for k, v in request.query_params.multi_items():\n"
        "            if k in cols:\n"
        "                q = q.where(k == v)\n"
        "        return q\n"
        "    return handler\n",
        # The tabsii-crm#239 shape: no query params read at all.
        "def make_thing_list_handler(model):\n"
        "    async def handler():\n"
        "        return select(model)\n"
        "    return handler\n",
    ],
    ids=["silently-ignores-unknown", "reads-no-query-params"],
)
def test_the_guard_rejects_a_handler_that_bypasses_the_helper(source: str):
    """A guard that has never failed is not yet evidence. Both historical defect
    shapes are fed to the same predicates the tests above use, and both must be
    caught — otherwise the assertions are only passing because nothing in
    ``routing/`` currently looks like this."""
    module = ast.parse(source)
    func = _top_level_functions(module)[0]
    assert _is_list_handler_factory(func.name)
    assert not (_called_names(func) & SHARED_FILTER_HELPERS)
