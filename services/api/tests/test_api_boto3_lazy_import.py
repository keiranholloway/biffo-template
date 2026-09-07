"""Regression guard for issue #1856: an eager module-scope ``import boto3`` in
``services/api/src/api/events/base.py`` meant constructing ``EventPublisher``'s
boto3 client imported the full boto3/botocore chain at *import* time -- before
any ``EventPublisher`` was ever instantiated, let alone used to publish an
event -- front-loading that cost onto every cold start and defeating every
downstream instance's own cold-start import-time fix (the same *class* of
defect #1779 fixed for ``aws_xray_sdk``/botocore via ``Tracer()``, guarded by
``test_main_tracer_import_order.py``; this file follows that guard's shape).

The fix (already merged, independently prosecuted -- verdict SURVIVES) moved
``import boto3`` into ``EventPublisher.__init__``, matching the lazy pattern
already in place at every other boto3 call site in this package
(``cognito.py``, ``database.py``, ``plugin_storage.py``, ``endpoint_control.py``,
``chat_engine.py``). What the prosecution named as the one residual gap: no
regression test/guard existed in *this* repo, so a future re-introduction of a
module-scope boto3 import anywhere in the chain would go undetected until
someone re-ran the manual importtime/sys.modules check by hand. This file adds
that guard. (``tabsii-platform``'s own downstream
``test_boto3_absent_from_sys_modules_after_import_api_main`` -- referenced in
#1856's body -- already does the behavioural half of this at the *instance*
level; this is the template-owned equivalent so the regression is caught at
the source, not three hops downstream after it has already shipped.)

Two invariants, mirroring ``test_main_tracer_import_order.py``:

1. **Positional** (``test_no_import_time_boto3_or_botocore_import_in_api_package``):
   an AST walk over every ``.py`` file in ``services/api/src/api/``, asserting
   no ``import boto3`` / ``from botocore ...`` executes at *import* time --
   module top level, or nested in a compound statement that itself runs
   unconditionally at import time (``if``/``try``/``with``/``for``/``while``/a
   class body), but never inside a function or method body (only runs when
   called) and never inside an ``if TYPE_CHECKING:`` branch (never runs at
   all). This catches a reintroduction *anywhere* in the package, not only in
   ``events/base.py``, and reports the exact file and line -- added value
   beyond the behavioural test alone, the same reasoning
   ``test_main_tracer_import_order.py`` gives for keeping both: a positional
   check fails on the exact line that re-arms the trap, while a behavioural
   failure only tells you *that* something did, not *what*.
2. **Behavioural** (``test_import_api_main_does_not_load_boto3``): proves the
   positional invariant actually has the load-bearing effect it claims, run in
   a fresh subprocess -- boto3/botocore are process-global caches, and by the
   time any test in this suite runs, other tests have almost certainly already
   imported ``api.main`` (and instantiated a real client somewhere), which
   would make "not yet imported" untestable from inside the existing pytest
   session. Imports ``api.main`` alone -- no route called, no
   ``EventPublisher``/``CognitoAdmin``/etc. ever instantiated, no event
   published -- and asserts ``boto3`` is absent from ``sys.modules``
   afterward.

   ``botocore`` is deliberately **not** asserted absent in the behavioural
   test, unlike ``boto3``. ``main.py``'s own ``tracer = Tracer()`` (the #1779
   fix) still runs at module-import time -- it is only deferred past the last
   ``include_router()`` call, not removed -- and ``Tracer.__init__``
   unconditionally does ``from aws_xray_sdk.core import xray_recorder``, which
   imports botocore as an accepted, already-prosecuted cost (see
   ``test_main_tracer_import_order.py``). Asserting botocore's absence here
   would fail on every clean run regardless of this issue, for a reason that
   has nothing to do with ``EventPublisher`` or boto3 -- confirmed empirically
   while writing this test: a fresh ``import api.main`` leaves
   ``"botocore" in sys.modules`` True and ``"boto3" in sys.modules`` False.
   boto3 has no such accepted eager import anywhere in ``api.main``'s own
   import chain, so its absence is the correct behavioural invariant. The
   positional guard above still checks source text for both ``boto3`` and
   ``botocore`` imports, because a *new* eager botocore import outside the
   already-accepted ``Tracer()`` path would be exactly this class of
   regression too, and the AST check has no reason to special-case it the way
   the subprocess probe must.
"""

from __future__ import annotations

import ast
import subprocess
import sys
import textwrap
from pathlib import Path

# Built via .joinpath(...) rather than a "/"-chain: see
# test_main_tracer_import_order.py's identical note for why a "/"-chain
# would trip python-test-scope-scan.ts's detector. That precedent's own
# comment is explicit that its `.joinpath()` use is safe *because* it only
# needs `domains/` as a `__path__` entry and "nothing ... asserts what
# domains/ contains" -- a condition this file did NOT preserve until #1893:
# the walk below used to run over `_API_ROOT.rglob("*.py")` directly, which
# DOES read and assert the content of every file under `domains/`, a path
# `core-manifest.json` marks `userOwned` (ADR-0022). That is precisely the
# defect class #1454's scope guard exists to catch, and the guard reported
# green only because its regex-only "/"-chain heuristic never sees a
# `.joinpath()` + `.rglob()` reach (confirmed live: a synthetic
# `domains/_instance_probe/__init__.py` with a module-scope `import boto3`
# made the real test fail, while `findPythonTestAssertedPaths` never listed
# `domains/` among the reached paths). See `_target_python_files` below,
# which now excludes `domains/` from the walk explicitly -- this file's
# invariant applies only to template-owned code, never to an instance's own
# product-domain code.
_SRC = Path(__file__).resolve().parents[1] / "src"
_API_ROOT = _SRC.joinpath("api")

_FORBIDDEN_MODULES = frozenset({"boto3", "botocore"})


def _target_python_files(api_root: Path) -> list[Path]:
    """Every ``.py`` file under ``api_root`` this guard checks -- excluding
    ``domains/``, which is user-owned (ADR-0022, ``core-manifest.json``).

    This guard is template-owned and must never assert over instance-owned
    content (#1893): an instance's own product-domain code under
    ``services/api/src/api/domains/<name>/`` is not this template's to
    police, and a downstream `biffo core upgrade` that fails an instance on
    its own domain code, with no channel to fix it short of editing that
    domain code to satisfy a rule this file imposes, is exactly the defect
    class #1454's scope guard exists to catch. Unlike
    ``test_main_tracer_import_order.py``'s identical ``.joinpath()`` use
    (which only needs ``domains/`` as a ``__path__`` entry and never reads
    its content), this test walks and asserts file content -- so avoiding
    python-test-scope-scan.ts's "/"-chain detector was never sufficient here
    on its own; the exclusion below is what actually keeps the invariant
    template-owned-only, not the ``.joinpath()`` construction by itself.
    """
    domains_root = api_root.joinpath("domains")
    return sorted(path for path in api_root.rglob("*.py") if domains_root not in path.parents)


def _is_type_checking_guard(node: ast.If) -> bool:
    test = node.test
    if isinstance(test, ast.Name) and test.id == "TYPE_CHECKING":
        return True
    return bool(isinstance(test, ast.Attribute) and test.attr == "TYPE_CHECKING")


def _walk_import_time_statements(body: list[ast.stmt]) -> list[ast.stmt]:
    """Every statement that executes at *import* time: module top level, or
    nested inside a compound statement (``If``/``Try``/``With``/``For``/
    ``While``/a class body) that itself runs unconditionally at import time.

    Does NOT recurse into ``FunctionDef``/``AsyncFunctionDef`` bodies -- those
    only execute when called, which is exactly the lazy pattern this guard
    requires -- and does not recurse into an ``if TYPE_CHECKING:`` branch,
    which never executes at runtime at all.
    """
    out: list[ast.stmt] = []
    for node in body:
        out.append(node)
        if isinstance(node, ast.If):
            if _is_type_checking_guard(node):
                continue
            out.extend(_walk_import_time_statements(node.body))
            out.extend(_walk_import_time_statements(node.orelse))
        elif isinstance(node, ast.Try):
            out.extend(_walk_import_time_statements(node.body))
            for handler in node.handlers:
                out.extend(_walk_import_time_statements(handler.body))
            out.extend(_walk_import_time_statements(node.orelse))
            out.extend(_walk_import_time_statements(node.finalbody))
        elif isinstance(node, ast.With | ast.AsyncWith):
            out.extend(_walk_import_time_statements(node.body))
        elif isinstance(node, ast.For | ast.AsyncFor | ast.While):
            out.extend(_walk_import_time_statements(node.body))
            out.extend(_walk_import_time_statements(node.orelse))
        elif isinstance(node, ast.ClassDef):
            out.extend(_walk_import_time_statements(node.body))
        # FunctionDef/AsyncFunctionDef/Lambda: deliberately not recursed into.
    return out


def _forbidden_imports_in_source(source: str, filename: str = "<test>") -> list[tuple[str, int]]:
    tree = ast.parse(source, filename=filename)
    findings: list[tuple[str, int]] = []
    for node in _walk_import_time_statements(tree.body):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if top in _FORBIDDEN_MODULES:
                    findings.append((alias.name, node.lineno))
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.module.split(".")[0] in _FORBIDDEN_MODULES:
                findings.append((node.module, node.lineno))
    return findings


def test_no_import_time_boto3_or_botocore_import_in_api_package() -> None:
    """Static half: no ``.py`` file under ``services/api/src/api/`` (excluding
    the user-owned ``domains/`` carve-out -- see ``_target_python_files``)
    may import boto3/botocore at a point that executes when the module is
    imported -- only inside a function or method body, constructed lazily on
    first actual use (the pattern already in place at ``cognito.py``,
    ``database.py``, ``plugin_storage.py``, ``endpoint_control.py``,
    ``chat_engine.py``, and ``events/base.py``'s ``EventPublisher.__init__``).

    Fails on the pre-#1856 layout, where ``events/base.py`` had
    ``import boto3`` at module top -- confirmed by temporarily reintroducing
    exactly that during development of this test.
    """
    offenders: list[str] = []
    for path in _target_python_files(_API_ROOT):
        source = path.read_text(encoding="utf-8")
        findings = _forbidden_imports_in_source(source, filename=str(path))
        for name, lineno in findings:
            offenders.append(f"{path.relative_to(_SRC)}:{lineno}: import {name}")
    assert not offenders, (
        "found boto3/botocore imported at module-import time (not inside a "
        "function/method body) -- this eagerly front-loads the boto3/botocore "
        "import chain onto every cold start regardless of whether the client "
        "is ever used, defeating every instance's own cold-start import-time "
        "fix (issue #1856). Move the import inside the function/method that "
        "actually needs the client, immediately before its first use:\n" + "\n".join(offenders)
    )


def test_ast_walker_flags_a_module_scope_boto3_import() -> None:
    """Proof the static check above is not vacuous: a synthetic file with
    ``import boto3`` at module top must be flagged."""
    findings = _forbidden_imports_in_source("import boto3\n\nclient = boto3.client('events')\n")
    assert findings == [("boto3", 1)]


def test_ast_walker_flags_a_module_scope_from_botocore_import() -> None:
    findings = _forbidden_imports_in_source("from botocore.exceptions import ClientError\n")
    assert findings == [("botocore.exceptions", 1)]


def test_ast_walker_ignores_a_function_scoped_boto3_import() -> None:
    """The sanctioned pattern -- ``import boto3`` inside ``__init__``/a
    method body -- must NOT be flagged, or this guard would fail on the
    correct, already-fixed code it exists to protect."""
    source = textwrap.dedent(
        """
        class EventPublisher:
            def __init__(self) -> None:
                import boto3

                self._client = boto3.client("events")
        """
    )
    assert _forbidden_imports_in_source(source) == []


def test_ast_walker_ignores_a_type_checking_guarded_import() -> None:
    """`if TYPE_CHECKING: import boto3` never executes at runtime, so it
    carries no cold-start cost and must not be flagged."""
    source = textwrap.dedent(
        """
        from typing import TYPE_CHECKING

        if TYPE_CHECKING:
            import boto3
        """
    )
    assert _forbidden_imports_in_source(source) == []


def test_ast_walker_flags_an_import_inside_a_module_level_try_block() -> None:
    """A bare module-level `try: import boto3 except ImportError: ...` still
    executes at import time -- unlike a function body, a `try` block has no
    deferred-execution semantics -- so it must be flagged too."""
    source = textwrap.dedent(
        """
        try:
            import boto3
        except ImportError:
            boto3 = None
        """
    )
    assert _forbidden_imports_in_source(source) == [("boto3", 3)]


def test_target_python_files_excludes_domains_directory(tmp_path: Path) -> None:
    """Structural proof of the #1893 fix: ``domains/`` must never appear in
    the walked file set, even though it contains a real ``.py`` file with a
    module-scope ``boto3`` import that would otherwise fail
    ``test_no_import_time_boto3_or_botocore_import_in_api_package``.

    Mirrors #1893's own reproduction exactly (a synthetic
    ``domains/_instance_probe/__init__.py`` with ``import boto3`` at module
    scope), but against a throwaway ``tmp_path`` tree rather than writing
    into this repo's real ``services/api/src/api/domains/`` -- doing the
    latter would itself be a template-owned test asserting over (by
    creating) content in a user-owned path, the exact defect class this fix
    exists to close.
    """
    api_root = tmp_path / "api"
    (api_root / "domains" / "_instance_probe").mkdir(parents=True)
    (api_root / "domains" / "_instance_probe" / "__init__.py").write_text(
        "import boto3\n\nclient = boto3.client('sns')\n", encoding="utf-8"
    )
    (api_root / "events").mkdir(parents=True)
    (api_root / "events" / "base.py").write_text(
        "class EventPublisher:\n    pass\n", encoding="utf-8"
    )

    files = _target_python_files(api_root)

    assert all("domains" not in path.parts for path in files), (
        f"domains/ leaked into the walked file set: {files}"
    )
    assert api_root / "events" / "base.py" in files


_PROBE = textwrap.dedent(
    """
    import sys

    sys.path.insert(0, {src!r})

    import api.main  # noqa: F401  (triggers the real module-level execution;
    # no route is called and no EventPublisher/CognitoAdmin/etc is ever
    # instantiated, so nothing here should have a reason to construct a boto3
    # client)

    print("boto3" in sys.modules)
    """
)


def _run_probe() -> bool:
    script = _PROBE.format(src=str(_SRC))
    result = subprocess.run(  # noqa: S603
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, (
        f"fresh-subprocess `import api.main` failed:\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )
    lines = [line.strip() for line in result.stdout.strip().splitlines() if line.strip()]
    return lines[-1] == "True"


def test_import_api_main_does_not_load_boto3() -> None:
    """The real property #1856 is about: `boto3` must not already be in
    `sys.modules` after `import api.main` alone. main.py's own module-level
    execution -- including constructing the real `tracer = Tracer()` (#1779)
    -- must not, directly or transitively, construct a boto3 client.
    """
    boto3_present = _run_probe()
    assert not boto3_present, (
        "boto3 was already imported after `import api.main` alone -- no route "
        "was called and no EventPublisher/CognitoAdmin/etc was ever "
        "instantiated, so boto3 should not be in sys.modules yet (issue "
        "#1856). Something in the import chain is constructing a boto3 client "
        "eagerly at module-import time again."
    )
