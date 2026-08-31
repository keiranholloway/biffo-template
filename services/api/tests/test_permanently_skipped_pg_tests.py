"""The growth guard for biffo-template#1648.

## What #1648 found

`biffo-template` carries five real-Postgres test modules (``test_*_pg.py``)
guarding code this template ships — including the plugin workflow
declare/seed route's ``except IntegrityError`` cold-start race handler
(#1633). Every one of them is skipped in **every** CI run here, by
construction: this repo provisions no Postgres service anywhere in
``.github/workflows/``, so ``pytest.mark.skipif(_pg_dsn() is None, ...)``
always evaluates true. A skip reports green exactly like a pass, so nothing
in the suite's own output distinguished "this race handler is correct" from
"this test has never executed once" — and the second was the true one.

#1648 chose option 2 from its own list: make the skip loud, and stop a new
permanently-skipped-for-infra-reasons test from being added the same silent
way. This module is the second half. The first half is the ``reason=``
string on each ``test_*_pg.py`` module's ``pytest.mark.skipif``, which now
says plainly, in the test output itself, that the test has never run here —
see any of those five files.

## What this guard does, and does not, protect against

This is a **ratchet**, the same shape as ``error-branch-baseline.json``
(#956) and ``mustBeUniform`` (AGENTS.md §9): it records the current count of
permanently-skipped-for-no-Postgres-lane test functions and fails only when
that count **grows** without a deliberate, visible bump to the baseline file
alongside it. It does not fail on the 28 that already exist — punishing
day-one residue trains people to stop reading the gate (AGENTS.md's
``protection-audit.sh`` makes this point at length).

It also does not run these tests, and cannot: there is still no Postgres
lane here (see the issue for why that option, and deferring to instance
verification, were both ruled out of scope for this fix). A count staying
flat is not evidence the handler is correct — only that nobody added a
sixth untested assumption next to the first five without saying so.

**Deliberately not anti-tamper.** ``error_branch_coverage.py`` fetches its
own script and baseline from the default branch before judging a PR,
specifically so a PR cannot edit the gate and the thing it measures in the
same commit. Building that machinery for a two-field JSON ratchet would be
more than the small, scoped guard #1648 asked for — building one from
scratch beyond that would need its own review. A PR that inflates the
baseline to hide a silently-reintroduced quiet skip is still visible in
`git diff`, the same way any other baseline bump is; nothing here catches it
automatically. That is the stated limit of this guard, not an oversight.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _TESTS_DIR.parents[2]
_BASELINE_PATH = _REPO_ROOT / "docs" / "practices" / "permanently-skipped-pg-tests-baseline.json"

#: Every permanently-skipped-for-infra-reasons module must say so somewhere
#: in its skip reason, in words alarming enough that a reader scanning `-rs`
#: output cannot mistake it for an ordinary conditional skip.
_LOUD_MARKER = "NEVER EXECUTED IN THIS REPO"


def _pg_test_modules() -> list[Path]:
    """Every real-Postgres test module this repo carries, sorted for determinism."""
    return sorted(_TESTS_DIR.glob("test_*_pg.py"))


def _skipif_reason(tree: ast.Module) -> str | None:
    """The string passed to this module's `pytest.mark.skipif(..., reason=...)`.

    Structural (AST), not a text grep for `pytest.mark.skipif` — a grep would
    also match the string inside this docstring. Returns None if the module
    has no such call, or the reason isn't a plain string literal (adjacent
    string literals like the five modules use are already folded into one
    `ast.Constant` by the parser, so this needs no special-casing for them).
    """
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr == "skipif"):
            continue
        for kw in node.keywords:
            if kw.arg == "reason" and isinstance(kw.value, ast.Constant):
                value = kw.value.value
                if isinstance(value, str):
                    return value
    return None


def _test_function_count(tree: ast.Module) -> int:
    """Every `test_*` function in the module, at any nesting depth."""
    return sum(
        1
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
        and node.name.startswith("test_")
    )


def _quiet_modules(names_and_sources: dict[str, str]) -> list[str]:
    """Names of modules whose skipif reason is missing or lacks `_LOUD_MARKER`.

    Pure function of `{filename: source}` so both the real five files and a
    synthetic quiet one can be checked the same way -- see
    `test_a_module_with_the_old_quiet_reason_is_flagged` below, which is the
    "write the input that reaches the handler" half of this guard: without
    it, `test_every_pg_test_module_has_a_loud_skip_reason` only ever proves
    the CURRENT five files pass, never that a quiet one would be caught.
    """
    missing_or_quiet: list[str] = []
    for name, source in names_and_sources.items():
        tree = ast.parse(source, filename=name)
        reason = _skipif_reason(tree)
        if reason is None or _LOUD_MARKER not in reason:
            missing_or_quiet.append(name)
    return missing_or_quiet


def _growth_message(current_total: int, baseline_total: int, module_names: list[str]) -> str | None:
    """The failure message when `current_total` exceeds `baseline_total`, else None.

    Extracted so the growth branch itself -- not just today's flat count --
    has a direct test: `test_growth_over_baseline_is_flagged` below feeds it
    a synthetic 29-over-28 without touching the real baseline file or
    creating a real sixth `test_*_pg.py` module.
    """
    if current_total <= baseline_total:
        return None
    return (
        f"{current_total} test functions across {module_names} "
        f"are now permanently skipped in this repo's CI (no Postgres lane "
        f"here -- biffo-template#1648), up from a recorded baseline of "
        f"{baseline_total}. If this growth is deliberate, update "
        f"'total' in {_BASELINE_PATH.relative_to(_REPO_ROOT)} in the same "
        "PR and say why in the PR body -- do not let it pass silently."
    )


def test_every_pg_test_module_has_a_loud_skip_reason() -> None:
    """A new `test_*_pg.py` file must say plainly that it never runs here.

    Fails without the loud reason (e.g. reverting to the old bare `"no real
    Postgres DSN -- ..."` wording, or omitting `reason=` altogether): that is
    exactly the silence #1648 was filed to stop, since a skip with no
    reason -- or a reason that reads like an ordinary conditional one --
    reports identically to a test that ran and passed.
    """
    modules = _pg_test_modules()
    assert modules, "no test_*_pg.py modules found -- update this test's assumptions"

    sources = {path.name: path.read_text() for path in modules}
    missing_or_quiet = _quiet_modules(sources)

    assert not missing_or_quiet, (
        "these test_*_pg.py modules skip without the loud "
        f"'{_LOUD_MARKER}' reason biffo-template#1648 requires: "
        f"{missing_or_quiet}. A quiet skip here reports identically to a "
        "test that ran and passed -- see any other test_*_pg.py module for "
        "the wording to copy."
    )


def test_a_module_with_the_old_quiet_reason_is_flagged() -> None:
    """The branch `test_every_pg_test_module_has_a_loud_skip_reason` relies on
    to catch a regression, exercised directly against the exact wording this
    repo shipped before #1648 -- proving the check would have failed on it.
    """
    quiet_source = (
        "import pytest\n"
        "pytestmark = pytest.mark.skipif(\n"
        "    True,\n"
        "    reason='no real Postgres DSN -- eval \"$(sh scripts/pg-test-db.sh --export)\"',\n"
        ")\n"
    )
    assert _quiet_modules({"test_fake_pg.py": quiet_source}) == ["test_fake_pg.py"]


def test_a_module_with_no_skipif_at_all_is_flagged() -> None:
    """A brand-new `test_*_pg.py` file that forgets `pytest.mark.skipif`
    entirely -- the other way this could silently regress."""
    assert _quiet_modules({"test_fake_pg.py": "def test_thing():\n    pass\n"}) == [
        "test_fake_pg.py"
    ]


def test_permanently_skipped_pg_test_count_has_not_grown() -> None:
    """The ratchet: fail if MORE tests join the never-runs-in-this-repo pile
    without a deliberate, visible baseline bump in the same PR.

    This never fails on the pre-existing 28 -- only on a 29th (or more)
    added without touching
    docs/practices/permanently-skipped-pg-tests-baseline.json alongside it.
    If you are adding a genuinely new Postgres-only test, that file is where
    to record the new count, in the open, rather than letting this guard
    catch it as a surprise.
    """
    baseline = json.loads(_BASELINE_PATH.read_text())
    baseline_total = baseline["total"]

    modules = _pg_test_modules()
    current_total = sum(
        _test_function_count(ast.parse(p.read_text(), filename=str(p))) for p in modules
    )

    message = _growth_message(current_total, baseline_total, [p.name for p in modules])
    assert message is None, message

    if current_total < baseline_total:
        # Improved, in the sense that fewer tests are flying blind -- most
        # likely because the template gained a real Postgres lane (option 1)
        # and one of these modules stopped needing pytest.mark.skipif at
        # all. Not a failure, but the baseline should be lowered to keep the
        # ratchet meaningful (AGENTS.md's mustBeUniform makes the same call).
        print(
            f"::notice::permanently-skipped-pg-tests count dropped to "
            f"{current_total} from a baseline of {baseline_total} -- lower "
            f"'total' in {_BASELINE_PATH.relative_to(_REPO_ROOT)} to match."
        )


def test_growth_over_baseline_is_flagged() -> None:
    """The branch `test_permanently_skipped_pg_test_count_has_not_grown` relies
    on to catch a regression, exercised directly with a synthetic 29-over-28
    -- proving the ratchet actually fires, without editing the real baseline
    file or creating a sixth real `test_*_pg.py` module to force it.
    """
    message = _growth_message(29, 28, ["test_a_pg.py", "test_b_pg.py"])
    assert message is not None
    assert "29" in message
    assert "28" in message


def test_growth_at_or_below_baseline_is_not_flagged() -> None:
    assert _growth_message(28, 28, ["test_a_pg.py"]) is None
    assert _growth_message(27, 28, ["test_a_pg.py"]) is None
