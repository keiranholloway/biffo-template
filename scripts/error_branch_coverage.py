#!/usr/bin/env python3
"""Which error-handling branches has the test suite never executed? (#956)

A fail-open is a check that passes without checking. Four surfaced on
2026-07-30 alone, none caught by a gate, and every one lived in a branch that
runs only when something has already gone wrong — an `except` that swallows, a
fallback that returns a permissive default. Ordinary line coverage hides them:
the happy path through a function is well covered, so the file looks fine.

This asks the narrower question. For every `except` handler and every
`return`-a-default fallback, did the suite ever run it? An unexecuted error
branch is not automatically a defect, but it is *unverified* — nobody has ever
observed what it does — and today's evidence is that this is precisely where
fail-opens live.

## Why a ratchet rather than a gate

Plenty of error branches are legitimately untested: an `except ImportError`
around an optional dependency, a defensive re-raise. A hard gate at this
precision gets switched off, taking the real findings with it — the same reason
the substring-assertion lint in #957 was scoped down after measurement. So this
records a **baseline** and fails only when the count *grows*: new unverified
error handling has to be a deliberate, visible choice.

## Scope, stated plainly

**Python only.** The three fail-opens found on 2026-07-30 were in three
different languages — shell (`scripts/verify.sh`'s `ci_has`), TypeScript
(branch-protection's 403 skip) and Python (the plugin-host lifespan
misclassification). This catches the Python one. Shell has no practical coverage
story and is not in scope; TypeScript is a possible follow-on via vitest
coverage. Claiming otherwise would be the same shape of error this tool exists
to find.

Usage:
    uv run pytest --cov --cov-report=json      # writes coverage.json
    python scripts/error_branch_coverage.py            # report
    python scripts/error_branch_coverage.py --write    # update the baseline
    python scripts/error_branch_coverage.py --check    # fail if it grew
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BASELINE = REPO_ROOT / "docs/practices/error-branch-baseline.json"
COVERAGE_JSON = REPO_ROOT / "coverage.json"

# The two commands that take the first measurement, in the order they must run.
# Named in every message about a missing baseline, because the missing piece is
# never obvious from the failure: the analyser reads `coverage.json`, which only
# exists after a --cov run, and neither the FileNotFoundError nor "N error
# branches added" says so (#983).
BOOTSTRAP_COMMANDS = (
    "uv run pytest --cov --cov-report=json",
    "uv run python scripts/error_branch_coverage.py --write",
)

# Why an absent baseline is a normal state, not a broken repo.
#
# This script is template-owned and reaches every instance through `biffo core
# upgrade`. Its baseline is NOT, and must not be: the file is a measurement of
# the repo it lives in, so shipping the template's copy would assert the
# template's unexecuted branches against an instance's tree — wrong data, naming
# files that do not exist there.
#
# So the test travels and its data cannot, and every instance arrives at this
# gate having never taken the measurement. A ratchet with no prior position
# should start, not block.
NO_BASELINE_MESSAGE = (
    f"No error-branch baseline at {BASELINE.relative_to(REPO_ROOT)}.\n"
    "\n"
    "That file is a measurement of THIS repo, so it is not distributed by a core\n"
    "upgrade — a fresh instance has simply never taken it (#983). Take it with:\n"
    "\n"
    f"  {BOOTSTRAP_COMMANDS[0]}\n"
    f"  {BOOTSTRAP_COMMANDS[1]}\n"
    "\n"
    "Until then the ratchet has no prior position to compare against, so it\n"
    "reports what it finds and does not fail."
)


@dataclass(frozen=True)
class Branch:
    """One error-handling branch, identified by where its body starts."""

    path: str
    line: int
    kind: str
    label: str

    def key(self) -> str:
        return f"{self.path}:{self.kind}:{self.label}"


def _handler_label(node: ast.ExceptHandler) -> str:
    if node.type is None:
        return "except:"
    try:
        return f"except {ast.unparse(node.type)}"
    except Exception:  # pragma: no cover - unparse is total on real trees
        return "except <?>"


def error_branches(tree: ast.AST, path: str) -> list[Branch]:
    """Every error-handling branch in one module.

    Two shapes, both of which have produced fail-opens in this estate:

    - an `except` handler, whose body runs only when something raised;
    - a bare `return`/`return <literal>` that is the *only* statement of an
      `if`, which is the fallback shape — "if we cannot tell, say yes".
    """
    found: list[Branch] = []

    for node in ast.walk(tree):
        if isinstance(node, ast.ExceptHandler):
            body = node.body[0]
            found.append(Branch(path, body.lineno, "except", _handler_label(node)))
            continue

        if isinstance(node, ast.If) and len(node.body) == 1:
            stmt = node.body[0]
            if not isinstance(stmt, ast.Return) or stmt.value is None:
                continue
            # Only constant defaults. A computed return is ordinary control
            # flow; `return True` / `return frozenset()` under a guard is the
            # shape that decides a question by assumption.
            if isinstance(stmt.value, ast.Constant) or (
                isinstance(stmt.value, ast.Call)
                and isinstance(stmt.value.func, ast.Name)
                and stmt.value.func.id in {"set", "frozenset", "list", "dict", "tuple"}
                and not stmt.value.args
            ):
                try:
                    label = f"if {ast.unparse(node.test)[:50]} -> {ast.unparse(stmt.value)}"
                except Exception:  # pragma: no cover
                    label = "if <?> -> <?>"
                found.append(Branch(path, stmt.lineno, "fallback", label))

    return found


def unexecuted(coverage: dict, root: Path) -> list[Branch]:
    """Error branches whose first executed line never ran under the suite."""
    files = coverage.get("files", {})
    out: list[Branch] = []

    for rel, data in sorted(files.items()):
        source = root / rel
        if not source.is_file():
            continue
        try:
            tree = ast.parse(source.read_text())
        except SyntaxError:
            continue

        executed = set(data.get("executed_lines", []))
        # A line coverage.py never considered (a comment, say) is not evidence
        # of anything; only count a branch whose body line is one coverage.py
        # tracked and reported as missing.
        missing = set(data.get("missing_lines", []))

        for branch in error_branches(tree, rel):
            if branch.line in executed:
                continue
            if branch.line in missing:
                out.append(branch)

    return out


def load_baseline() -> dict | None:
    """The committed baseline, or None when this repo has never taken one.

    None rather than an empty baseline. They are different states and used to be
    conflated: an empty baseline means "measured, and found nothing", which for a
    tree this size means the analyser is broken; a missing one means "never
    measured". Reading the second as the first made every branch look NEW and
    red-lit the gate on every instance that upgraded (#983).
    """
    if not BASELINE.is_file():
        return None
    return json.loads(BASELINE.read_text())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="record the current set as baseline")
    parser.add_argument("--check", action="store_true", help="fail if the count grew")
    parser.add_argument("--coverage", type=Path, default=COVERAGE_JSON)
    args = parser.parse_args()

    if not args.coverage.is_file():
        print(
            f"No coverage data at {args.coverage}.\nRun:  uv run pytest --cov --cov-report=json",
            file=sys.stderr,
        )
        return 2

    coverage = json.loads(args.coverage.read_text())
    found = unexecuted(coverage, REPO_ROOT)
    keys = sorted({b.key() for b in found})

    if args.write:
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE.write_text(
            json.dumps({"total": len(keys), "branches": keys}, indent=2) + "\n",
        )
        print(f"baseline written: {len(keys)} unexecuted error branches")
        return 0

    baseline = load_baseline()
    if baseline is None:
        # Report, then stop. Loudly, on stderr, naming both commands — a gate
        # that goes quiet without saying so is the fail-open this whole script
        # exists to hunt.
        print(NO_BASELINE_MESSAGE, file=sys.stderr)
        for branch in sorted(found, key=lambda b: (b.path, b.line)):
            print(f"      {branch.path}:{branch.line}  [{branch.kind}] {branch.label}")
        print(f"unexecuted error branches: {len(keys)}  (no baseline yet)")
        return 0

    known = set(baseline.get("branches", []))
    new = [k for k in keys if k not in known]

    print(f"unexecuted error branches: {len(keys)}  (baseline {baseline.get('total', 0)})")
    for branch in sorted(found, key=lambda b: (b.path, b.line)):
        marker = "NEW " if branch.key() not in known else "    "
        print(f"  {marker}{branch.path}:{branch.line}  [{branch.kind}] {branch.label}")

    if args.check and new:
        print(
            f"\n{len(new)} error branch(es) added with no test exercising them:",
            file=sys.stderr,
        )
        for k in new:
            print(f"  {k}", file=sys.stderr)
        print(
            "\nAn unexecuted error branch is unverified — nobody has observed what it does.\n"
            "Either cover it, or run --write to accept it deliberately.",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
