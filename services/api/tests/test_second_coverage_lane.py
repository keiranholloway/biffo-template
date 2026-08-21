"""The second-coverage-lane resolver, and the agreement it exists to enforce (#1597).

Two kinds of test here, and the second kind is the point.

The unit tests pin the resolver's behaviour on synthetic trees. The tests at the
bottom run against **this repo as it actually is**, and assert the property that
no amount of careful reading enforces: that the gate and `ci.yml` agree about
whether a lane exists, and that a lane the repo actually has can actually
trigger the gate. That is the `guard-vs-authority` class (#1362) — a guard
reading a different document than the thing that acts — and its recorded remedy
is a disagreement test, which is what these are.
"""

import importlib.util
import sys
from pathlib import Path

import yaml

_ROOT = Path(__file__).resolve().parents[3]
_SCRIPT = _ROOT / "scripts" / "second_coverage_lane.py"
_spec = importlib.util.spec_from_file_location("second_coverage_lane", _SCRIPT)
assert _spec is not None and _spec.loader is not None
lane_mod = importlib.util.module_from_spec(_spec)
sys.modules["second_coverage_lane"] = lane_mod
_spec.loader.exec_module(lane_mod)


def _workflow(tmp_path: Path, filename: str, body: str) -> Path:
    d = tmp_path / ".github" / "workflows"
    d.mkdir(parents=True, exist_ok=True)
    p = d / filename
    p.write_text(body)
    return p


_UPLOADS = """\
name: {name}
on:
  push:
jobs:
  lane:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v5
        with:
          name: {artefact}
          path: rls-coverage.json
"""


class TestFindingTheLane:
    def test_a_workflow_that_uploads_the_artefact_is_the_lane(self, tmp_path):
        _workflow(
            tmp_path,
            "anything.yml",
            _UPLOADS.format(name="Postgres Tests", artefact="rls-coverage"),
        )
        lane = lane_mod.find_lane(tmp_path)
        assert lane is not None
        assert lane.workflow_name == "Postgres Tests"

    def test_the_filename_is_irrelevant(self, tmp_path):
        # The whole point of #1597: a repo with no RLS should not have to name
        # its lane after RLS to be seen.
        _workflow(
            tmp_path,
            "database-tests.yaml",
            _UPLOADS.format(name="Database Tests", artefact="rls-coverage"),
        )
        assert lane_mod.find_lane(tmp_path).path.name == "database-tests.yaml"

    def test_a_workflow_uploading_something_else_is_not_the_lane(self, tmp_path):
        _workflow(tmp_path, "ci.yml", _UPLOADS.format(name="CI", artefact="python-coverage"))
        assert lane_mod.find_lane(tmp_path) is None

    def test_the_consumer_is_not_mistaken_for_the_lane(self, tmp_path):
        # The gate DOWNLOADS `rls-coverage`. A text search for the artefact
        # name would match it and make the gate detect itself — which is why
        # `_publishes_artefact` walks the step structure instead of grepping.
        #
        # SHARPER SINCE #1666: the consumer is now a step inside `ci.yml`
        # itself. If the detector grepped, `ci.yml` would detect ITSELF as the
        # second lane, and the gate would sit waiting for a run named "CI" to
        # conclude — from inside the run named "CI". A self-deadlock until the
        # wait times out, on every commit in every repo.
        _workflow(
            tmp_path,
            "ci.yml",
            "name: CI\non:\n  push:\njobs:\n  python:\n    runs-on: ubuntu-latest\n"
            "    steps:\n      - run: gh run download --name rls-coverage\n",
        )
        assert lane_mod.find_lane(tmp_path) is None

    def test_the_real_ci_yml_is_not_detected_as_the_lane(self):
        # The same thing against the actual tree, because the test above
        # proves the RULE and this proves THIS REPO obeys it. #1666 put a
        # `gh run download --name rls-coverage` into ci.yml for real.
        doc = lane_mod._load(_ROOT / ".github" / "workflows" / "ci.yml")
        assert doc is not None
        assert not lane_mod._publishes_artefact(doc, lane_mod.LANE_ARTEFACT), (
            "ci.yml is being detected as the second coverage lane. The gate step "
            "inside it would then wait for CI to conclude from inside CI, "
            "deadlocking until the wait times out on every commit."
        )

    def test_a_workflow_with_no_name_falls_back_to_its_filename(self, tmp_path):
        # Mirrors GitHub: an unnamed workflow is displayed, and matched by
        # `workflow_run`, under its path.
        body = _UPLOADS.format(name="X", artefact="rls-coverage").replace("name: X\n", "", 1)
        _workflow(tmp_path, "unnamed.yml", body)
        assert lane_mod.find_lane(tmp_path).workflow_name == "unnamed.yml"

    def test_a_tree_with_no_workflows_directory_is_not_an_error(self, tmp_path):
        assert lane_mod.find_lane(tmp_path) is None

    def test_a_malformed_workflow_does_not_raise(self, tmp_path):
        # This runs inside a gate. Dying on someone else's unrelated typo
        # converts it into a blocked merge queue.
        _workflow(tmp_path, "broken.yml", "name: [unclosed\n")
        _workflow(tmp_path, "good.yml", _UPLOADS.format(name="Lane", artefact="rls-coverage"))
        assert lane_mod.find_lane(tmp_path).workflow_name == "Lane"

    def test_a_non_workflow_file_is_ignored(self, tmp_path):
        d = tmp_path / ".github" / "workflows"
        d.mkdir(parents=True)
        (d / "notes.md").write_text("uses: actions/upload-artifact\nname: rls-coverage\n")
        assert lane_mod.find_lane(tmp_path) is None


class TestTheOnKeyTrap:
    """YAML 1.1 resolves a bare `on` to the boolean True.

    Every GitHub workflow ever written has this key, so a parser that reads
    `doc["on"]` finds nothing anywhere — and in a detector, "no triggers found"
    silently becomes "no lane" for the whole estate.
    """

    def test_pyyaml_really_does_coerce_on_to_true(self):
        assert list(yaml.safe_load("name: X\non:\n  push:\n")) == ["name", True]


class TestTheGateIsWiredAndTrusted:
    """#1666 folded the gate from its own `workflow_run` workflow into a step.

    The two-callers-drift class these tests used to guard (#1362) is designed
    out — there is one caller now, so there is nothing to disagree. What
    replaced it is a set of properties the fold could silently lose, and
    losing any of them leaves a gate that looks configured and gates nothing.
    """

    @staticmethod
    def _ci() -> str:
        return (_ROOT / ".github" / "workflows" / "ci.yml").read_text()

    def test_the_separate_gate_workflow_is_gone(self):
        assert not (_ROOT / ".github" / "workflows" / "error-branch-coverage-gate.yml").exists(), (
            "The workflow_run gate is back alongside the inline step. Both post the "
            "'Error-branch coverage' context, so the commit is asserted twice and "
            "whichever finishes last wins — including a stale one overwriting a real "
            "failure with success."
        )

    def test_the_only_caller_invokes_the_shared_resolver(self):
        assert "second_coverage_lane.py" in self._ci(), (
            "ci.yml no longer asks the shared resolver whether this repo has a second "
            "lane, so it is deciding by some other means — which is the RLS-filename "
            "bug this module exists to have ended."
        )

    def test_it_does_not_decide_by_the_rls_filename(self):
        assert "hashFiles('.github/workflows/rls-tests.yml')" not in self._ci(), (
            "ci.yml decides whether a lane exists by matching an RLS-specific "
            "filename again, instead of asking scripts/second_coverage_lane.py."
        )

    def test_the_gate_never_sources_the_lane_output(self):
        # `lane.env` is GitHub Actions KEY=VALUE output -- deliberately unquoted -- and its
        # `name` comes from the workflow file in the COMMIT UNDER TEST. Sourcing it with
        # `.` was both a parse bug and a command injection, reproduced 2026-08-21:
        #
        #   name=RLS Tests -> `sh: ./lane.env: Tests: not found`, exit 127, so the REQUIRED
        #                     'Error-branch coverage' check got no verdict at all.
        #   name=$(id -u)  -> the uid was printed. Arbitrary code, inside the step whose
        #                     whole purpose is running only the default branch's scripts.
        ci = self._ci()
        assert ". ./lane.env" not in ci and "source ./lane.env" not in ci, (
            "ci.yml sources lane.env. A workflow name containing $(...) or backticks then "
            "executes inside the trusted gate -- the pwn-request shape this step exists to "
            "prevent. Parse it with sed instead."
        )
        assert "sed -n 's/^name=//p' lane.env" in ci, (
            "lane.env values must be extracted without a shell evaluating them."
        )

    def test_the_gate_runs_the_trusted_copies_not_the_commits_own(self):
        # THE property `workflow_run` used to provide by construction: it ran
        # the DEFAULT BRANCH's copy of everything, so a commit could never edit
        # the thing judging it. Inline, the checkout IS the commit under test,
        # so this has to be explicit — and if it is ever lost, a PR can edit
        # error_branch_coverage.py to `sys.exit(0)` and gate itself green.
        ci = self._ci()
        gate_step = ci[ci.index("- name: Error-branch coverage") :]
        gate_step = gate_step[: gate_step.index("- name: Report Error-branch coverage")]
        for script in ("error_branch_coverage.py", "second_coverage_lane.py"):
            assert f".gate-trusted/{script}" in gate_step, (
                f"The gate step does not run a trusted copy of {script}. It must fetch "
                "the default branch's copy and run that; running the checked-out one "
                "lets a PR edit its own gate to pass."
            )
            assert f"python3 scripts/{script}" not in gate_step, (
                f"The gate step runs the CHECKED-OUT scripts/{script} — i.e. the commit "
                "under test's own copy of the thing judging it."
            )

    def test_a_gate_that_cannot_run_reports_failure_not_success(self):
        # Every bail-out in the step must set `state=failure`. The pre-#637
        # inline version's defect was falling back to Python-only coverage when
        # the lane artefact was not there, silently — a fail-open. `state=` is
        # only ever written as success on an assertion that actually ran.
        ci = self._ci()
        gate_step = ci[ci.index("- name: Error-branch coverage") :]
        gate_step = gate_step[: gate_step.index("- name: Report Error-branch coverage")]
        successes = gate_step.count('echo "state=success"')
        assert successes == 2, (
            f"Expected exactly two success paths in the gate step (no-lane assertion "
            f"passed, combined assertion passed); found {successes}. A new success path "
            "is a new way for the gate to pass without having asserted anything."
        )
        assert "did not conclude for" in gate_step, (
            "The wait for the second lane no longer reports a timeout. A gate that "
            "cannot assert must say so; timing out silently is the fail-open that "
            "moved this logic out of ci.yml in the first place (#637)."
        )

    def test_the_required_context_is_posted_even_when_the_gate_crashes(self):
        # 'Error-branch coverage' is a REQUIRED context on some instances. A run
        # that posts nothing leaves every PR blocked with no explanation, which
        # is worse than a red gate because there is nothing to read.
        ci = self._ci()
        report = ci[ci.index("- name: Report Error-branch coverage") :]
        assert "if: ${{ always() &&" in report, (
            "The status-reporting step is not always(), so a crash in the gate step "
            "posts no status at all and the required context never arrives."
        )
        assert "state=failure" in report and "did not reach a verdict" in report, (
            "The reporting step does not default a missing verdict to failure. An "
            "empty state must be a failure, never an absence."
        )
