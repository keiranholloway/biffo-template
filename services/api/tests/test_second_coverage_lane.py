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

import pytest
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
        _workflow(
            tmp_path,
            "error-branch-coverage-gate.yml",
            "name: Error-branch coverage gate\non:\n  workflow_run:\n"
            "    workflows: ['CI']\njobs:\n  gate:\n    runs-on: ubuntu-latest\n"
            "    steps:\n      - run: gh run download --name rls-coverage\n",
        )
        assert lane_mod.find_lane(tmp_path) is None

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

    def test_the_trigger_list_is_read_despite_it(self, tmp_path):
        _workflow(
            tmp_path,
            "error-branch-coverage-gate.yml",
            "name: G\non:\n  workflow_run:\n    workflows: ['CI', 'Lane']\n"
            "jobs:\n  g:\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n",
        )
        assert lane_mod.trigger_workflow_names(tmp_path) == ["CI", "Lane"]

    def test_a_gate_without_a_workflow_run_trigger_reports_no_names(self, tmp_path):
        _workflow(tmp_path, "error-branch-coverage-gate.yml", "name: G\non:\n  push:\njobs: {}\n")
        assert lane_mod.trigger_workflow_names(tmp_path) == []


class TestThisRepoAgrees:
    """Run against the real tree — the disagreement tests (#1362).

    These are what stop the two callers drifting apart again. They are cheap,
    and their absence is the entire finding in every previous instance of this
    class.
    """

    def test_the_gate_still_triggers_on_ci(self):
        names = lane_mod.trigger_workflow_names(_ROOT)
        assert "CI" in names, (
            "The gate's workflow_run trigger no longer lists 'CI'. It fires on the "
            "completion of CI and the lane; without CI it can never see the Python "
            "job's coverage, and the combine can never happen."
        )

    def test_a_lane_in_this_repo_can_actually_trigger_the_gate(self):
        lane = lane_mod.find_lane(_ROOT)
        if lane is None:
            pytest.skip("this repo has no second coverage lane — nothing to agree about")
        names = lane_mod.trigger_workflow_names(_ROOT)
        assert lane.workflow_name in names, (
            f"{lane.path} publishes {lane_mod.LANE_ARTEFACT!r} from a workflow named "
            f"{lane.workflow_name!r}, which is not in the gate's workflow_run trigger "
            f"list {names}. `workflow_run.workflows` matches exact names with no "
            "globbing, so the gate would NEVER fire for this lane: its coverage is "
            "never combined and error-branch coverage is asserted over the Python job "
            "alone, while the repo looks fully configured. Rename the workflow to one "
            "of the accepted names, or add this one upstream in biffo-template."
        )

    def test_neither_caller_still_decides_by_the_rls_filename(self):
        # The bug this file exists to prevent recurring: two hand-written
        # `hashFiles('.github/workflows/rls-tests.yml')` tests, one per caller,
        # which is a second copy of a decision and therefore drifts.
        for wf in ("ci.yml", "error-branch-coverage-gate.yml"):
            text = (_ROOT / ".github" / "workflows" / wf).read_text()
            assert "hashFiles('.github/workflows/rls-tests.yml')" not in text, (
                f"{wf} decides whether a lane exists by matching an RLS-specific "
                "filename again. Both callers must ask "
                "scripts/second_coverage_lane.py instead, or they will disagree — "
                "and a disagreement means the commit is asserted twice, or nowhere."
            )

    def test_both_callers_invoke_the_shared_resolver(self):
        for wf in ("ci.yml", "error-branch-coverage-gate.yml"):
            text = (_ROOT / ".github" / "workflows" / wf).read_text()
            assert "second_coverage_lane.py" in text, (
                f"{wf} no longer calls the shared resolver, so the two callers are "
                "free to disagree about whether this repo has a second lane."
            )
