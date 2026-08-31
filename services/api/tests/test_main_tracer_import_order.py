"""Regression guard for issue #1779: constructing ``Tracer()`` at module top,
before any route is registered, front-loads a real import cost onto every
cold start and masks it from every downstream fix trying to measure its own.

The defect
----------
``Tracer()``'s ``__init__`` unconditionally calls ``aws_lambda_powertools``'s
own ``_patch_xray_provider()``, which does ``from aws_xray_sdk.core import
xray_recorder`` -- an eager, non-lazy import of the full X-Ray/botocore chain,
regardless of whether tracing ends up enabled. ``main.py`` used to construct
``tracer = Tracer()`` right after ``logger = Logger()``, before
``app.include_router(build_domain_router(), ...)`` (or any other router) ever
ran. So by the time an instance's own product-domain code
(``services/api/src/api/domains/<name>/``) got imported, ``aws_xray_sdk.core``
-- and everything it pulls in -- was already resident in ``sys.modules``,
making that domain's own X-Ray-adjacent imports look free and hiding whatever
cost a downstream fix was trying to defer (tabsii-platform#1238 failed
prosecution three times chasing a cost this template-owned file had already
paid on the instance's behalf).

The fix moves the construction to immediately before its only use --
decorating ``lambda_handler`` -- which is after every ``app.include_router()``
call, including ``build_domain_router()``.

Two invariants asserted here
-----------------------------
1. **Positional** (``test_tracer_is_constructed_after_every_include_router_call``):
   read out of ``main.py``'s own source via AST, not hardcoded, so reverting
   the construction back to module top fails this test instead of quietly
   re-arming the trap.
2. **Behavioural** (``test_tracer_construction_does_not_pre_import_xray_before_domain_router``):
   proves the positional invariant actually has the effect claimed, rather than
   asserting a line-number fact that happens to correlate with it. Runs in a
   fresh subprocess -- ``aws_xray_sdk.core`` is a process-global cache, and by
   the time any test in this suite runs, other tests have almost certainly
   already imported ``api.main`` (and therefore constructed the real
   ``tracer``) in-process, which would make the "not yet imported" half of the
   claim untestable from inside the existing pytest session.
"""

from __future__ import annotations

import ast
import subprocess
import sys
import textwrap
from pathlib import Path

from api import main as api_main

_SRC = Path(__file__).resolve().parents[1] / "src"


def _module_level_statements() -> list[ast.stmt]:
    tree = ast.parse(Path(api_main.__file__).read_text(encoding="utf-8"))
    return list(tree.body)


def _last_include_router_lineno(body: list[ast.stmt]) -> int:
    linenos = [
        node.lineno
        for node in body
        if isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Call)
        and isinstance(node.value.func, ast.Attribute)
        and node.value.func.attr == "include_router"
        and isinstance(node.value.func.value, ast.Name)
        and node.value.func.value.id == "app"
    ]
    assert linenos, "found no app.include_router(...) calls in main.py -- check the AST walk"
    return max(linenos)


def _tracer_assignment_lineno(body: list[ast.stmt]) -> int:
    for node in body:
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == "tracer"
        ):
            return node.lineno
    raise AssertionError("found no module-level `tracer = ...` assignment in main.py")


def test_tracer_is_constructed_after_every_include_router_call() -> None:
    """Structural half: ``tracer = Tracer()`` must sit textually after the last
    ``app.include_router(...)`` call, so nothing importable via a route/domain
    can be beaten to `sys.modules` by the tracer's own import side effect.

    Fails on the pre-#1779 layout, where the assignment sits right after
    ``logger = Logger()`` -- before every include_router call.
    """
    body = _module_level_statements()
    last_router = _last_include_router_lineno(body)
    tracer_line = _tracer_assignment_lineno(body)
    assert tracer_line > last_router, (
        f"tracer = Tracer() is declared at main.py:{tracer_line}, but the last "
        f"app.include_router(...) call is at line {last_router}. Tracer() eagerly "
        "imports aws_xray_sdk.core (issue #1779) -- move the construction below "
        "every include_router() call, immediately before its own use decorating "
        "lambda_handler."
    )


# The probe run in a fresh subprocess, below. Pre-registers a synthetic
# instance product domain in sys.modules (the base template ships no
# services/api/src/api/domains/ tree to import for real) and wraps
# build_domain_router so it records whether `aws_xray_sdk.core` is already
# resident in sys.modules the moment it is called -- before importing
# api.main runs any further module-level code, including wherever `tracer`
# ends up declared.
_PROBE = textwrap.dedent(
    """
    import sys
    import types

    sys.path.insert(0, {src!r})

    import api.routing.domain_router as domain_router

    domains_pkg = types.ModuleType("api.domains")
    domains_pkg.__path__ = []
    probe_mod = types.ModuleType("api.domains._probe")
    probe_mod.routers = []
    sys.modules["api.domains"] = domains_pkg
    sys.modules["api.domains._probe"] = probe_mod
    domain_router._discover_domain_names = lambda: ["_probe"]

    _original_build_domain_router = domain_router.build_domain_router
    state = {{}}


    def _wrapped():
        state["xray_before_domain_router"] = "aws_xray_sdk.core" in sys.modules
        return _original_build_domain_router()


    domain_router.build_domain_router = _wrapped

    if {simulate_bug!r}:
        # Reproduce the pre-#1779 shape directly, without depending on git
        # history: construct a Tracer() before anything else runs, exactly as
        # main.py used to at module top. Proves the probe's own detection
        # mechanism actually distinguishes the two states, rather than always
        # printing "not yet imported" regardless of what happened.
        from aws_lambda_powertools import Tracer

        Tracer()

    import api.main  # noqa: F401  (triggers the real module-level execution)

    state["xray_after_full_import"] = "aws_xray_sdk.core" in sys.modules
    print(state["xray_before_domain_router"])
    print(state["xray_after_full_import"])
    """
)


def _run_probe(*, simulate_bug: bool) -> tuple[bool, bool]:
    script = _PROBE.format(src=str(_SRC), simulate_bug=simulate_bug)
    result = subprocess.run(  # noqa: S603
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, (
        f"probe subprocess failed (simulate_bug={simulate_bug}):\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )
    lines = [line.strip() for line in result.stdout.strip().splitlines() if line.strip()]
    before, after = lines[-2], lines[-1]
    return before == "True", after == "True"


def test_tracer_construction_does_not_pre_import_xray_before_domain_router() -> None:
    """The real property #1779 is about, exercised the way main.py actually
    assembles the app: ``aws_xray_sdk.core`` must not already be in
    ``sys.modules`` at the moment ``build_domain_router()`` runs, and the
    tracer must still genuinely get constructed (and therefore import it) by
    the time the module finishes loading -- this is a reorder, not a removal.
    """
    xray_before, xray_after = _run_probe(simulate_bug=False)
    assert not xray_before, (
        "aws_xray_sdk.core was already imported before build_domain_router() ran -- "
        "Tracer() is being constructed too early again (issue #1779), pre-warming "
        "an import cost that then hides in whatever a product domain imports next."
    )
    assert xray_after, (
        "aws_xray_sdk.core was never imported at all -- tracer = Tracer() appears "
        "to have been removed rather than reordered."
    )


def test_the_probe_actually_detects_the_pre_fix_ordering() -> None:
    """Proof the guard above is not vacuous: simulate the old module-top
    construction directly (not via git history) and confirm the probe reports
    exactly the pre-#1779 signature -- xray already imported before
    build_domain_router() runs at all."""
    xray_before, xray_after = _run_probe(simulate_bug=True)
    assert xray_before, (
        "the probe failed to detect a Tracer() constructed before route registration"
    )
    assert xray_after
