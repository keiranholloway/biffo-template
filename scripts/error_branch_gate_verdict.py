#!/usr/bin/env python3
"""Can the error-branch coverage gate assert on this commit yet — and if not, why?

One question, asked once, from ONE authority (#1362's recorded remedy).

## What was wrong

`.github/workflows/error-branch-coverage-gate.yml` is a required status check on
`dev` in every instance. It runs on `workflow_run`, so it must post its own
commit status via the REST Statuses API addressed to the commit under test —
that indirection is the whole mechanism, and it had **reachable paths that
posted nothing at all**.

A required context that is never posted does not render as "pending". It renders
as `expected`: invisible on the PR, absent from `gh pr checks`, and refusing the
merge with `Required status check "Error-branch coverage" is expected.` The
header of the gate reasoned that leaving no status was safe because "pending
blocks merge exactly as a failure would". That is true of a status that exists
and is pending. It is not true of a status that was never posted — that is not a
strict gate, it is a gate that cannot be passed, and the only recovery
(re-running CI so the gate fires again) is nowhere stated on the PR.

Measured on `tabsii-com/tabsii-platform`, 2026-08-18:

    PR #951  e80a6dd6  CI cancelled, RLS Tests success  -> no status, ever
    PR #952  142cb4b5  CI cancelled, RLS Tests success  -> no status, ever
    PR #953  a54eaa1d  CI cancelled, RLS Tests success  -> no status, ever

Gate runs 32128129670 and 32128394921 both logged, for 142cb4b5:

    Only one of {CI, RLS Tests} has a SUCCESSFUL completed run for
    142cb4b5... so far (ci=<none> lane=32126454650)

and exited 0 having posted nothing. `CI` had concluded **`cancelled`** — the
house failure mode on this estate's self-hosted spot runners — so it would never
appear in a `conclusion == "success"` lookup, and no further `workflow_run` event
was ever coming.

## What decides it now

The gate asks this module, and this module distinguishes two things the old
inline shell conflated into one silent `exit 0`:

- **`pending`** — a lane has not finished yet, or has not been dispatched. This
  is the ordinary shape of whichever of the two workflows completes first, it is
  transient, and a later completion will fire the gate again and resolve it.
- **`failure`** — every run of a lane has finished and none succeeded. Nothing
  will re-fire the gate for this commit. This is terminal, and a required check
  facing a terminal condition must say so rather than stay silent.

The caller posts a status for every one of these, so no path leaves the context
absent. See `--github-output`.

## Why the triggering run is not consulted

The old shell branched on `github.event.workflow_run.name`/`.conclusion`, taking
the triggering run's id directly when it fired for `CI`, and looking the other
one up via the API. Two authorities for the same fact, which is exactly the
class #1362 tracks: the event payload is a **snapshot** taken when the run
concluded, and a later re-run makes it stale while the API's answer moves on.
`tabsii-platform` PR #985 (b085ca48) shows the divergence live — its `CI` run
32128658649 is on `run_attempt: 2`, and the gate firing that carried attempt 1's
`conclusion` disagreed with the API listing that reports attempt 2's.

So the event is treated as a **wake-up, not evidence**. This module reads only
the Actions run listing for the commit, which cannot disagree with itself, and
answers the same way no matter which workflow's completion happened to fire the
gate. That also deletes the old `else` branch for "triggered by a workflow in the
trigger list that is not this repo's lane" — there is nothing left for it to get
wrong.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

#: The Python lane. Named by `ci.yml`'s `name:`, which is what the Actions API
#: reports and what `workflow_run` matches on.
CI_WORKFLOW_NAME = "CI"

#: GitHub's `status` is lifecycle, not outcome. Anything that is not
#: `completed` — `queued`, `in_progress`, `waiting`, `requested`, `pending` —
#: is a run that has not finished, and is therefore a reason to wait rather
#: than a reason to fail. Constraining on `status` ALONE is #1363/#1462's
#: recorded defect; this module constrains on `conclusion` for success and
#: uses `status` only to tell "not yet" from "never".
COMPLETED = "completed"


@dataclass(frozen=True)
class LaneState:
    """What the Actions listing says about one workflow at one commit."""

    name: str
    #: Newest run whose `conclusion` is `success`, or None.
    succeeded_run_id: int | None
    #: A run of this workflow exists that has not finished yet.
    unfinished: bool
    #: Terminal conclusions of every finished run, newest first, for the reason
    #: string. Empty when no run of this workflow exists at all.
    concluded: tuple[str, ...]

    @property
    def resolved(self) -> bool:
        return self.succeeded_run_id is not None

    @property
    def terminal_without_success(self) -> bool:
        """Every run finished, none succeeded — nothing will re-fire the gate.

        `not self.unfinished` alone is not enough: a commit with NO run of this
        workflow at all also has nothing unfinished, and that is a wait (the run
        may not have been dispatched yet), not a terminal verdict. Requiring at
        least one concluded run is what keeps a not-yet-dispatched lane out of
        the failure branch.
        """
        return not self.resolved and not self.unfinished and bool(self.concluded)


def lane_state(runs: list[dict], name: str) -> LaneState:
    """Read one workflow's state out of a `GET /actions/runs` payload."""
    mine = [r for r in runs if isinstance(r, dict) and r.get("name") == name]

    succeeded = [r for r in mine if r.get("conclusion") == "success"]
    # Newest by run id rather than by list position: the API documents no
    # ordering guarantee, and a resolver whose answer depends on JSON order is
    # a resolver that changes its mind for no reason.
    newest = max((r for r in succeeded), key=lambda r: r.get("id", 0), default=None)

    unfinished = any(r.get("status") != COMPLETED for r in mine)
    concluded = tuple(
        str(r.get("conclusion"))
        for r in sorted(mine, key=lambda r: r.get("id", 0), reverse=True)
        if r.get("status") == COMPLETED
    )

    return LaneState(
        name=name,
        succeeded_run_id=int(newest["id"]) if newest is not None else None,
        unfinished=unfinished,
        concluded=concluded,
    )


@dataclass(frozen=True)
class Verdict:
    """What the gate should do, and what it should say while doing it."""

    #: `assert` · `pending` · `failure`. Never empty — a verdict this module
    #: cannot name would put the caller straight back into the silent path this
    #: whole module exists to remove.
    verdict: str
    reason: str
    ci_run_id: int | None = None
    lane_run_id: int | None = None


def _describe(state: LaneState) -> str:
    if not state.concluded:
        return f"{state.name} has no run for this commit yet"
    if state.unfinished:
        return f"{state.name} is still running"
    return f"{state.name} finished {'/'.join(state.concluded)} with no successful run"


def decide(runs: list[dict], lane_name: str) -> Verdict:
    """The gate's verdict for one commit.

    `runs` is `.workflow_runs` from `GET /repos/{repo}/actions/runs?head_sha=…`,
    unfiltered — deliberately not pre-filtered on `status=completed`, because
    "has not finished" is one of the three answers this function exists to
    distinguish and a pre-filter throws it away.
    """
    ci = lane_state(runs, CI_WORKFLOW_NAME)
    lane = lane_state(runs, lane_name)

    if ci.resolved and lane.resolved:
        return Verdict(
            verdict="assert",
            reason=(
                f"combining {CI_WORKFLOW_NAME} run {ci.succeeded_run_id} "
                f"+ {lane.name} run {lane.succeeded_run_id}"
            ),
            ci_run_id=ci.succeeded_run_id,
            lane_run_id=lane.succeeded_run_id,
        )

    blocked = [s for s in (ci, lane) if not s.resolved]

    # Terminal beats transient. A commit where one lane is still running and the
    # other has already finished unsuccessfully is NOT going to become
    # assertable when the first one lands, so reporting it as `pending` would
    # promise a resolution that is not coming.
    if any(s.terminal_without_success for s in blocked):
        return Verdict(
            verdict="failure",
            reason=(
                "; ".join(_describe(s) for s in blocked)
                + " — re-run it, then this gate will re-fire"
            ),
        )

    return Verdict(
        verdict="pending",
        reason="waiting for " + "; ".join(_describe(s) for s in blocked),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--runs",
        type=Path,
        required=True,
        help="JSON body of GET /repos/{repo}/actions/runs?head_sha=… ('-' for stdin)",
    )
    parser.add_argument(
        "--lane-name",
        required=True,
        help="the second coverage lane's workflow name, from second_coverage_lane.py",
    )
    parser.add_argument(
        "--github-output",
        action="store_true",
        help=(
            "emit `verdict=`/`reason=`/`ci_run_id=`/`lane_run_id=` lines for "
            "$GITHUB_OUTPUT. Always exits 0 when the payload is readable: "
            "`pending` and `failure` are ANSWERS, and a caller forced to tell "
            "them apart by exit code ends up conflating them with 'the resolver "
            "broke' — which is the silent path this module replaces"
        ),
    )
    args = parser.parse_args()

    text = sys.stdin.read() if str(args.runs) == "-" else args.runs.read_text()
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        # Exit 2, distinct from any verdict: the caller must post a `failure`
        # for "cannot tell", never a pass and never silence.
        print(f"could not parse the runs payload: {exc}", file=sys.stderr)
        return 2

    runs = payload.get("workflow_runs") if isinstance(payload, dict) else None
    if not isinstance(runs, list):
        print("the runs payload has no `workflow_runs` array", file=sys.stderr)
        return 2

    result = decide(runs, args.lane_name)

    if args.github_output:
        print(f"verdict={result.verdict}")
        # Newlines would forge extra $GITHUB_OUTPUT keys; a workflow name is
        # repo-controlled text and reaches `reason` through `_describe`.
        print("reason=" + result.reason.replace("\r", " ").replace("\n", " "))
        if result.ci_run_id is not None:
            print(f"ci_run_id={result.ci_run_id}")
        if result.lane_run_id is not None:
            print(f"lane_run_id={result.lane_run_id}")
        return 0

    print(f"{result.verdict}: {result.reason}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
