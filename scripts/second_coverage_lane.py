#!/usr/bin/env python3
"""Does this tree have a second coverage lane, and what is its workflow called?

One question, asked in two places, answered here once (#1597).

## What was wrong

`.github/workflows/error-branch-coverage-gate.yml` combines the Python job's
coverage with a second lane's before asserting. To do that it has to know
whether this repo HAS such a lane — and it decided by matching an
**RLS-specific filename and workflow name**:

    workflows: ['CI', 'RLS Tests']
    gh api ".../contents/.github/workflows/rls-tests.yml?ref=$SHA"
    select(.name == "RLS Tests")

`ci.yml`'s inline single-artefact check stood down on the same filename, via
`hashFiles('.github/workflows/rls-tests.yml')`.

Row-level security is one reason to want a real-Postgres lane, not the only one.
`biffo-platform` has **zero** RLS policies and four `test_*_pg.py` modules that
had never run in CI; adding a lane there was plainly right, and naming it
honestly (`postgres-tests.yml`) would have left the gate on its "no lane" path
posting nothing **while simultaneously re-enabling the inline check**. The
honest name was the fail-open and the misnomer was load-bearing, so that repo
had to lie about what it guards in order to be guarded correctly.

## What decides it now

The property that actually matters: **something in this tree publishes the
lane's coverage artefact.** That is what the gate consumes, so that is what it
asks about. Filename and workflow name are free.

The artefact name stays `rls-coverage` deliberately. It is an internal
identifier rather than a human-facing label, every existing lane already
publishes it, and renaming it estate-wide would be a breaking change across
repos to fix a cosmetic wart — while introducing, during the migration, exactly
the two-names-for-one-thing split this module exists to remove. One declared
interface, documented here.

## Why a shared resolver rather than two careful greps

Both callers must agree. If the gate thinks there is a lane and `ci.yml` does
not, the commit is asserted twice; if the reverse, it is asserted **nowhere** —
green, having checked nothing. That is the estate's `guard-vs-authority`
class (biffo-template#1362), whose recorded remedy is precisely this: prefer one
resolver over shared discipline where the same question is asked twice.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

#: The artefact a second coverage lane must publish to be seen by the gate.
#: This is THE interface — see the module docstring for why it keeps its
#: historical, RLS-flavoured name.
LANE_ARTEFACT = "rls-coverage"

#: Where the gate lives, so the trigger-list check can read its own `on:` block.
GATE_WORKFLOW = Path(".github/workflows/error-branch-coverage-gate.yml")

WORKFLOW_DIR = Path(".github/workflows")


@dataclass(frozen=True)
class Lane:
    """A workflow that publishes the lane coverage artefact."""

    path: Path
    #: The workflow's `name:`, which is what `workflow_run` matches on. Falls
    #: back to the filename, mirroring GitHub: a workflow with no `name:` is
    #: displayed, and matched, by its path.
    workflow_name: str


def _load(path: Path) -> dict | None:
    """Parse a workflow, or None if it is not a YAML mapping.

    Never raises on a malformed file: this runs inside a gate, and a gate that
    dies on an unrelated broken workflow converts someone else's typo into a
    blocked merge queue.
    """
    try:
        doc = yaml.safe_load(path.read_text())
    except (yaml.YAMLError, OSError, UnicodeDecodeError):
        return None
    return doc if isinstance(doc, dict) else None


def _on_block(doc: dict) -> dict:
    """A workflow's triggers, surviving YAML 1.1's `on` → `True` coercion.

    PyYAML resolves the bare key `on` to the BOOLEAN True (YAML 1.1 treats
    on/off/yes/no as booleans), so `doc["on"]` is a `KeyError` on every GitHub
    workflow ever written. Reading it as `True` is not a cute trick, it is the
    only way this works — and getting it wrong yields a parser that silently
    finds no triggers anywhere, which in a detector means "no lane" everywhere.
    """
    block = doc.get("on", doc.get(True))
    return block if isinstance(block, dict) else {}


def _publishes_artefact(doc: dict, artefact: str) -> bool:
    """True when any job step uploads `artefact`.

    Deliberately structural rather than a text search: a grep for the artefact
    name also matches the string inside a comment, or inside the gate's own
    `gh run download --name rls-coverage` (the CONSUMER), which would make the
    gate detect itself as the lane.
    """
    jobs = doc.get("jobs")
    if not isinstance(jobs, dict):
        return False

    for job in jobs.values():
        if not isinstance(job, dict):
            continue
        steps = job.get("steps")
        if not isinstance(steps, list):
            continue
        for step in steps:
            if not isinstance(step, dict):
                continue
            uses = step.get("uses")
            if not isinstance(uses, str) or not uses.startswith("actions/upload-artifact"):
                continue
            with_block = step.get("with")
            if isinstance(with_block, dict) and with_block.get("name") == artefact:
                return True
    return False


def find_lane(root: Path, artefact: str = LANE_ARTEFACT) -> Lane | None:
    """The workflow in `root` that publishes the lane artefact, if any.

    Sorted for determinism. A repo with two such workflows is not a supported
    shape — the gate downloads exactly one `rls-coverage` — so the first is
    taken and `--check` reports the ambiguity separately rather than silently
    picking a winner here.
    """
    for path in sorted(lane_candidates(root)):
        doc = _load(path)
        if doc is not None and _publishes_artefact(doc, artefact):
            name = doc.get("name")
            return Lane(
                path=path.relative_to(root),
                workflow_name=name if isinstance(name, str) and name else path.name,
            )
    return None


def lane_candidates(root: Path) -> list[Path]:
    """Every workflow file, in a form that does not care about the extension."""
    workflows = root / WORKFLOW_DIR
    if not workflows.is_dir():
        return []
    return [p for p in workflows.iterdir() if p.suffix in {".yml", ".yaml"} and p.is_file()]


def trigger_workflow_names(root: Path) -> list[str]:
    """The workflow names the gate's `workflow_run` trigger will fire for.

    `workflow_run.workflows` takes exact names — GitHub supports no globbing
    there — so this list is an unavoidable constant, and a lane whose name is
    absent from it NEVER TRIGGERS THE GATE. That is the failure this function
    exists to make visible; see `--check`.
    """
    doc = _load(root / GATE_WORKFLOW)
    if doc is None:
        return []
    run = _on_block(doc).get("workflow_run")
    if not isinstance(run, dict):
        return []
    names = run.get("workflows")
    return [n for n in names if isinstance(n, str)] if isinstance(names, list) else []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="tree to inspect")
    parser.add_argument(
        "--check",
        action="store_true",
        help=(
            "also assert the lane's workflow name appears in the gate's "
            "workflow_run trigger list — a lane the gate can never be triggered "
            "by is worse than no lane, because the repo believes it is covered"
        ),
    )
    parser.add_argument(
        "--github-output",
        action="store_true",
        help=(
            "emit `present=`/`name=`/`path=` lines for $GITHUB_OUTPUT and exit 0 "
            "whether or not a lane exists. Absence is an ordinary answer to this "
            "question, not an error, and a workflow step that has to distinguish "
            "the two by exit code ends up conflating 'no lane' with 'the "
            "resolver broke'"
        ),
    )
    args = parser.parse_args()
    root = args.root.resolve()

    lane = find_lane(root)

    if args.github_output:
        print(f"present={'true' if lane else 'false'}")
        if lane:
            print(f"name={lane.workflow_name}")
            print(f"path={lane.path}")
        return 0

    if lane is None:
        print("no second coverage lane in this tree")
        return 1

    print(f"lane: {lane.path} (workflow name: {lane.workflow_name!r})")

    if args.check:
        names = trigger_workflow_names(root)
        if not names:
            print(
                f"could not read a workflow_run trigger list from {GATE_WORKFLOW} — "
                "cannot confirm this lane would ever trigger the gate.",
                file=sys.stderr,
            )
            return 2
        if lane.workflow_name not in names:
            print(
                f"\nThis repo publishes {LANE_ARTEFACT!r} from a workflow named "
                f"{lane.workflow_name!r}, which is NOT in the gate's trigger list:\n"
                f"  {names}\n\n"
                "`workflow_run.workflows` matches exact names and supports no\n"
                "globbing, so the gate will never fire for this lane: its coverage\n"
                "is never combined, and error-branch coverage is asserted over the\n"
                "Python job alone while looking fully configured.\n\n"
                f"Rename the workflow to one of {names[1:]}, or add its name to\n"
                f"{GATE_WORKFLOW} upstream in biffo-template.",
                file=sys.stderr,
            )
            return 1
        print(f"trigger list contains {lane.workflow_name!r} — the gate will fire for it")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
