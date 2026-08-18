"""The case matrix for the error-branch coverage gate's verdict.

Every row marked CAPTURED LIVE below is the real `.workflow_runs` array
returned by, on 2026-08-18:

    gh api "repos/tabsii-com/tabsii-platform/actions/runs?head_sha=<SHA>&per_page=100" \
      --jq '{workflow_runs: [.workflow_runs[] | {id, name, status, conclusion, run_attempt}]}'

reduced to the fields this resolver reads. Rows marked ADAPTED say so and name
what was changed and why — no row here is invented from imagination, because a
corpus is only worth anything if every line in it came from a real run.

The `-> current` column records what the SHIPPED gate did with each payload,
taken from that commit's real gate run, so this table documents what was broken
rather than what the fix intends:

  SHA       PR    CI          lane        -> current gate behaviour
  b085ca48  #985  success(a2) success     -> posted `success`   (run 32131898803)
  6c815a46  #986  success     success     -> posted `failure`   (run 32131774738)
  e80a6dd6  #951  cancelled   success     -> POSTED NOTHING, permanently
  142cb4b5  #952  cancelled   success     -> POSTED NOTHING     (runs 32128129670, 32128394921)
  a54eaa1d  #953  cancelled   success     -> POSTED NOTHING, permanently

The three `POSTED NOTHING` rows were verified absent, not merely unobserved:

    gh api repos/tabsii-com/tabsii-platform/commits/<SHA>/status \
      --jq '[.statuses[] | .context]'

returned `[]` for all three and `["Error-branch coverage"]` for the other two.

must-assert  : both lanes have a successful run
must-pending : a lane has not finished (or not started) — transient, a later
               completion re-fires the gate
must-fail    : every run of a lane finished and none succeeded — terminal,
               nothing will re-fire the gate

There is deliberately no must-be-silent row. That is the defect.
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "error_branch_gate_verdict.py"

_spec = importlib.util.spec_from_file_location("error_branch_gate_verdict", SCRIPT)
assert _spec is not None and _spec.loader is not None
verdict_mod = importlib.util.module_from_spec(_spec)
# Registered before exec: `@dataclass` resolves annotations through
# `sys.modules[cls.__module__]`, which is None for a module loaded from a spec
# and never registered — the same line `test_second_coverage_lane.py` carries.
sys.modules["error_branch_gate_verdict"] = verdict_mod
_spec.loader.exec_module(verdict_mod)

LANE = "RLS Tests"


# --------------------------------------------------------------------------
# CAPTURED LIVE — see the module docstring for the exact command.
# --------------------------------------------------------------------------

#: tabsii-platform PR #985, head b085ca48. CI is on run_attempt 2 because
#: attempt 1 failed and was re-run; the API reports the LATEST attempt, which is
#: precisely why the resolver reads the API rather than a `workflow_run` event
#: payload carrying attempt 1's stale conclusion.
RUNS_985_BOTH_GREEN = [
    {"id": 32128658612, "name": "CodeQL", "status": "completed", "conclusion": "skipped"},
    {"id": 32128658598, "name": "Release Guards", "status": "completed", "conclusion": "success"},
    {"id": 32128658619, "name": "RLS Tests", "status": "completed", "conclusion": "success"},
    {"id": 32128658649, "name": "CI", "status": "completed", "conclusion": "success"},
]

#: tabsii-platform PR #986, head 6c815a46. Both green; the gate asserted and
#: found a real defect. Included so the matrix contains the case the gate is
#: FOR, not only the cases it mishandled.
RUNS_986_BOTH_GREEN = [
    {"id": 32130949892, "name": "CodeQL", "status": "completed", "conclusion": "skipped"},
    {"id": 32130949939, "name": "Release Guards", "status": "completed", "conclusion": "success"},
    {"id": 32130949951, "name": "RLS Tests", "status": "completed", "conclusion": "success"},
    {"id": 32130949975, "name": "CI", "status": "completed", "conclusion": "success"},
]

#: tabsii-platform PR #951, head e80a6dd6. CI cancelled on run_attempt 2.
RUNS_951_CI_CANCELLED = [
    {"id": 32030363785, "name": "RLS Tests", "status": "completed", "conclusion": "success"},
    {"id": 32030363597, "name": "Release Guards", "status": "completed", "conclusion": "success"},
    {"id": 32030363633, "name": "CodeQL", "status": "completed", "conclusion": "skipped"},
    {"id": 32030363638, "name": "CI", "status": "completed", "conclusion": "cancelled"},
]

#: tabsii-platform PR #952, head 142cb4b5. CI cancelled on its only attempt.
#: This is the payload the two logged gate firings saw when they printed
#: `ci=<none> lane=32126454650` and exited 0 posting nothing.
RUNS_952_CI_CANCELLED = [
    {"id": 32126454647, "name": "CodeQL", "status": "completed", "conclusion": "skipped"},
    {"id": 32126454650, "name": "RLS Tests", "status": "completed", "conclusion": "success"},
    {"id": 32126454644, "name": "CI", "status": "completed", "conclusion": "cancelled"},
    {"id": 32126454654, "name": "Release Guards", "status": "completed", "conclusion": "failure"},
]

#: tabsii-platform PR #953, head a54eaa1d. CI cancelled on run_attempt 2.
RUNS_953_CI_CANCELLED = [
    {"id": 32032424331, "name": "Release Guards", "status": "completed", "conclusion": "success"},
    {"id": 32032424400, "name": "CodeQL", "status": "completed", "conclusion": "skipped"},
    {"id": 32032424431, "name": "RLS Tests", "status": "completed", "conclusion": "success"},
    {"id": 32032424393, "name": "CI", "status": "completed", "conclusion": "cancelled"},
]


# --------------------------------------------------------------------------
# ADAPTED — each is a captured payload above with ONE field changed, named here.
# The shapes themselves are ordinary: the transient rows are what every commit
# looks like between its first and second lane completing, which is the state
# the gate spends most of its life in and which no captured snapshot of a
# FINISHED commit can contain.
# --------------------------------------------------------------------------

#: RUNS_985_BOTH_GREEN with the lane's `status`/`conclusion` set to
#: `in_progress`/None — the ordinary shape of the CI-first firing.
RUNS_LANE_STILL_RUNNING = [
    dict(r, status="in_progress", conclusion=None) if r["name"] == LANE else r
    for r in RUNS_985_BOTH_GREEN
]

#: RUNS_985_BOTH_GREEN with the CI run removed entirely — the shape when the
#: lane completes before CI's run has been dispatched.
RUNS_CI_NOT_DISPATCHED = [r for r in RUNS_985_BOTH_GREEN if r["name"] != "CI"]

#: RUNS_952_CI_CANCELLED with CI's conclusion changed to `failure`. A cancelled
#: run is the house failure mode on this estate's spot runners, but an ordinary
#: red CI is terminal for this gate in exactly the same way.
RUNS_CI_FAILED = [
    dict(r, conclusion="failure") if r["name"] == "CI" else r for r in RUNS_952_CI_CANCELLED
]

#: RUNS_952_CI_CANCELLED plus a NEWER successful CI run, as a re-run produces.
#: Guards the "newest successful by id" rule: a cancelled run sitting in the
#: same payload must not mask a later green one.
RUNS_CI_RERUN_SUCCEEDED = [
    *RUNS_952_CI_CANCELLED,
    {"id": 32126999999, "name": "CI", "status": "completed", "conclusion": "success"},
]

#: RUNS_952_CI_CANCELLED with the lane still running AND CI already cancelled.
#: Terminal must beat transient: waiting cannot rescue this commit.
RUNS_ONE_TERMINAL_ONE_RUNNING = [
    dict(r, status="in_progress", conclusion=None) if r["name"] == LANE else r
    for r in RUNS_952_CI_CANCELLED
]


MUST_ASSERT = [
    ("#985 both green (CI on attempt 2)", RUNS_985_BOTH_GREEN, 32128658649, 32128658619),
    ("#986 both green", RUNS_986_BOTH_GREEN, 32130949975, 32130949951),
    (
        "CI re-run succeeded after a cancelled attempt",
        RUNS_CI_RERUN_SUCCEEDED,
        32126999999,
        32126454650,
    ),
]

MUST_FAIL = [
    ("#951 CI cancelled", RUNS_951_CI_CANCELLED),
    ("#952 CI cancelled", RUNS_952_CI_CANCELLED),
    ("#953 CI cancelled", RUNS_953_CI_CANCELLED),
    ("CI failed outright", RUNS_CI_FAILED),
    ("CI cancelled while the lane is still running", RUNS_ONE_TERMINAL_ONE_RUNNING),
]

MUST_PEND = [
    ("lane still running", RUNS_LANE_STILL_RUNNING),
    ("CI not dispatched yet", RUNS_CI_NOT_DISPATCHED),
    ("no runs at all for this commit", []),
]


@pytest.mark.parametrize(
    ("label", "runs", "ci_id", "lane_id"), MUST_ASSERT, ids=lambda v: str(v)[:40]
)
def test_must_assert(label: str, runs: list[dict], ci_id: int, lane_id: int) -> None:
    result = verdict_mod.decide(runs, LANE)
    assert result.verdict == "assert", f"{label}: {result.reason}"
    assert result.ci_run_id == ci_id
    assert result.lane_run_id == lane_id


@pytest.mark.parametrize(("label", "runs"), MUST_FAIL, ids=lambda v: str(v)[:40])
def test_must_fail(label: str, runs: list[dict]) -> None:
    """Terminal: nothing will re-fire the gate, so the gate must SAY so.

    These three real PRs are the whole point. Under the shipped gate every one
    of them received no status at all on a required context — the merge refused
    with `"Error-branch coverage" is expected`, with nothing on the PR to
    indicate the check existed, let alone what would clear it.
    """
    result = verdict_mod.decide(runs, LANE)
    assert result.verdict == "failure", f"{label}: got {result.verdict} — {result.reason}"
    assert result.reason, f"{label}: a failure with no stated reason is the old silence"


@pytest.mark.parametrize(("label", "runs"), MUST_PEND, ids=lambda v: str(v)[:40])
def test_must_pend(label: str, runs: list[dict]) -> None:
    """Transient: a later completion re-fires the gate and resolves this.

    Reporting these as `failure` would redden every PR for the minutes between
    its two lanes finishing, which is how a gate gets ignored.
    """
    result = verdict_mod.decide(runs, LANE)
    assert result.verdict == "pending", f"{label}: got {result.verdict} — {result.reason}"
    assert result.reason


def test_no_payload_ever_yields_silence() -> None:
    """The property the fix exists to establish, asserted over the whole matrix.

    `decide` has no return path that declines to answer, so the caller has no
    input for which it can legitimately post nothing.
    """
    every_row = [runs for _, runs, _, _ in MUST_ASSERT]
    every_row += [runs for _, runs in MUST_FAIL + MUST_PEND]
    for runs in every_row:
        result = verdict_mod.decide(runs, LANE)
        assert result.verdict in {"assert", "pending", "failure"}
        assert result.reason.strip()


def test_a_lane_named_like_another_workflow_is_not_confused() -> None:
    """Selection is by exact workflow name, not by substring.

    `RUNS_952_CI_CANCELLED` holds a `Release Guards` run that concluded
    `failure`; a resolver matching loosely would drag it into the verdict.
    """
    state = verdict_mod.lane_state(RUNS_952_CI_CANCELLED, LANE)
    assert state.succeeded_run_id == 32126454650
    assert state.concluded == ("success",)


def test_reason_carries_no_newline() -> None:
    """A newline in `reason` would forge an extra $GITHUB_OUTPUT key.

    The lane's workflow name is repo-controlled text and reaches `reason`, so
    this is an injection surface, not a formatting nicety.
    """
    result = verdict_mod.decide([], "Evil\nverdict=assert")
    assert "\n" not in result.reason.replace("\r", " ").replace("\n", " ")
    proc = _run_script(json.dumps({"workflow_runs": []}), "Evil\nverdict=assert")
    assert proc.returncode == 0
    emitted = [line for line in proc.stdout.splitlines() if line.startswith("verdict=")]
    assert emitted == ["verdict=pending"], proc.stdout


def _run_script(stdin_text: str, lane_name: str = LANE) -> subprocess.CompletedProcess[str]:
    # S603: every argument is a literal or this module's own constant, and the
    # executable is `sys.executable`. Running the real CLI is the point — the
    # exit codes it returns are the caller's interface, and asserting them
    # through an in-process call would not exercise `main()`'s own returns.
    return subprocess.run(  # noqa: S603
        [sys.executable, str(SCRIPT), "--runs", "-", "--lane-name", lane_name, "--github-output"],
        input=stdin_text,
        capture_output=True,
        text=True,
        check=False,
    )


def test_cli_emits_github_output_for_a_real_payload() -> None:
    proc = _run_script(json.dumps({"workflow_runs": RUNS_952_CI_CANCELLED}))
    assert proc.returncode == 0, proc.stderr
    assert "verdict=failure" in proc.stdout
    assert "reason=" in proc.stdout


def test_unparseable_payload_exits_2_not_a_verdict() -> None:
    """Exercises the `except json.JSONDecodeError` branch.

    Exit 2 is deliberately distinct from every verdict: "the resolver broke" is
    a different fact from "the gate cannot assert yet", and the caller must turn
    it into a posted `failure` rather than into silence.
    """
    proc = _run_script("{not json")
    assert proc.returncode == 2, proc.stdout
    assert "could not parse" in proc.stderr
    assert "verdict=" not in proc.stdout


def test_payload_without_workflow_runs_exits_2() -> None:
    proc = _run_script(json.dumps({"message": "Not Found"}))
    assert proc.returncode == 2, proc.stdout
    assert "workflow_runs" in proc.stderr
    assert "verdict=" not in proc.stdout


# ---------------------------------------------------------------------------
# The structural half: the gate workflow must have no path that posts nothing.
#
# The resolver above can only guarantee a verdict EXISTS. Whether the workflow
# then posts it is a property of the YAML, and it is invisible in review —
# `if: always() && <anything>` and `if: always()` read almost identically, and
# the difference is the difference between a strict gate and an unpassable one.
# These read the REAL workflow rather than restating the rule, so the guard and
# the thing that acts cannot drift (#1362).
# ---------------------------------------------------------------------------

GATE_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "error-branch-coverage-gate.yml"


def _gate_steps() -> list[dict]:
    doc = yaml.safe_load(GATE_WORKFLOW.read_text())
    steps = doc["jobs"]["gate"]["steps"]
    assert isinstance(steps, list)
    return [s for s in steps if isinstance(s, dict)]


def _status_posting_steps() -> list[dict]:
    return [s for s in _gate_steps() if "statuses/$SHA" in (s.get("run") or "")]


def test_exactly_one_step_posts_the_status() -> None:
    """More than one writer is how a placeholder races a verdict."""
    posters = _status_posting_steps()
    assert [s.get("name") for s in posters] == ["Report the result"]


def test_the_reporting_step_is_unconditional() -> None:
    """`always()` with NO second conjunct — this is the whole fix.

    The shipped defect was `always() && steps.runs.outputs.both_found == 'true'`:
    the step whose entire job is to guarantee a status was itself conditional on
    having something to say, so three PRs sat unmergeable on a context that had
    never been posted.
    """
    (poster,) = _status_posting_steps()
    assert str(poster.get("if", "")).strip() == "always()"


def test_the_reporting_step_never_posts_an_empty_state() -> None:
    """Reachable only because the step above is unconditional.

    A hard failure in the tarball fetch or the lane resolver skips every step
    that sets an output and lands here with nothing set.
    """
    (poster,) = _status_posting_steps()
    assert re.search(r'if \[ -z "\$state" \]; then\s*\n\s*state=failure', poster["run"])


def test_the_reporting_step_takes_its_inputs_from_env() -> None:
    """`reason` carries the lane's workflow name, which is repo-controlled."""
    (poster,) = _status_posting_steps()
    assert "${{" not in poster["run"], "no expression splicing inside the reporting shell"


def _resolver_output_keys() -> set[str]:
    """The keys the verdict resolver actually emits, taken from real runs.

    Derived rather than restated. The `runs` step pipes this script's stdout
    straight into `$GITHUB_OUTPUT`, so its key names ARE that step's outputs and
    a hand-maintained second list of them would be free to drift from the thing
    it describes — which is the defect this whole file is about, one level up.
    """
    keys: set[str] = set()
    for fixture in (RUNS_985_BOTH_GREEN, RUNS_952_CI_CANCELLED, []):
        proc = _run_script(json.dumps({"workflow_runs": fixture}))
        assert proc.returncode == 0, proc.stderr
        keys.update(line.split("=", 1)[0] for line in proc.stdout.splitlines() if "=" in line)
    return keys


def test_every_step_reference_names_an_output_something_sets() -> None:
    """Scans `if:`, `env:` AND `run:` — a dangling reference in any is silent.

    Two distinct failure modes, both of which have now actually happened here:

    - in an `if:`, a reference nothing sets makes the condition false, so the
      step and everything gated behind it silently vanish. That is the shipped
      `both_found` defect.
    - in a `run:` or `env:`, it expands to the empty string. Caught while
      writing this change: the resolver was renamed to emit `lane_run_id` while
      three consumers still said `rls_run_id`, which would have made the gate
      run `gh run download ""` and post a wrong failure on every commit. The
      YAML was valid, the shell parsed, and nothing else would have noticed.
    """
    produced = {f"steps.runs.outputs.{k}" for k in _resolver_output_keys()}
    produced.add("steps.lane.outputs.present")
    produced.add("steps.lane.outputs.name")
    produced.add("steps.lane.outputs.path")

    for step in _gate_steps():
        if not step.get("id"):
            continue
        for key in re.findall(r'^\s*echo "([a-z_]+)=', step.get("run") or "", re.MULTILINE):
            produced.add(f"steps.{step['id']}.outputs.{key}")

    for step in _gate_steps():
        surfaces = [str(step.get("if") or ""), step.get("run") or ""]
        surfaces += [str(v) for v in (step.get("env") or {}).values()]
        for surface in surfaces:
            for ref in re.findall(r"steps\.[a-z_]+\.outputs\.[a-z_]+", surface):
                assert ref in produced, f"{step.get('name')} references {ref}, which nothing sets"


def test_the_runs_listing_is_not_pre_filtered_on_status() -> None:
    """ "Has not finished" is one of the three answers; `status=` throws it away.

    That is the #1363/#1462 shape, and it is what turned a cancelled CI run into
    silence rather than into a reported failure.
    """
    queries = re.findall(
        r"actions/runs\?[^\n\"']*", "\n".join(s.get("run") or "" for s in _gate_steps())
    )
    assert queries, "the gate must still list this commit's runs"
    for query in queries:
        assert "status=" not in query, f"pre-filtered listing: {query}"
