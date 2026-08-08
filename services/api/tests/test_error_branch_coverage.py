"""The error-branch analyser itself (#956).

It is a gate, so it needs the same scepticism gates get here: a detector that
silently finds nothing is indistinguishable from a clean tree, and that is the
exact failure this estate keeps rediscovering. These tests pin both directions —
what it must find, and what it must not.
"""

import ast
import importlib.util
import json
import sys
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "error_branch_coverage.py"
_spec = importlib.util.spec_from_file_location("error_branch_coverage", _SCRIPT)
assert _spec is not None and _spec.loader is not None
ebc = importlib.util.module_from_spec(_spec)
# Registered before exec: @dataclass resolves its own module through sys.modules,
# and a module loaded by spec alone is not there yet.
sys.modules["error_branch_coverage"] = ebc
_spec.loader.exec_module(ebc)


def _branches(src: str):
    return ebc.error_branches(ast.parse(src), "x.py")


class TestWhatItFinds:
    def test_an_except_handler(self):
        found = _branches("try:\n    f()\nexcept ValueError:\n    pass\n")
        assert [(b.kind, b.label) for b in found] == [("except", "except ValueError")]

    def test_a_bare_except(self):
        assert _branches("try:\n    f()\nexcept:\n    pass\n")[0].label == "except:"

    def test_a_constant_fallback_return(self):
        # The ci_has() shape: cannot tell, so say yes.
        found = _branches("def f(x):\n    if not x:\n        return True\n    return g(x)\n")
        assert [b.kind for b in found] == ["fallback"]
        assert "-> True" in found[0].label

    def test_an_empty_collection_fallback(self):
        src = "def f(x):\n    if x is None:\n        return frozenset()\n    return h(x)\n"
        assert [b.kind for b in _branches(src)] == ["fallback"]

    def test_the_body_line_is_the_branch_line_not_the_keyword(self):
        # Coverage records the statement that runs, not the `except` clause.
        found = _branches("try:\n    f()\nexcept OSError:\n    g()\n")
        assert found[0].line == 4


class TestWhatItMustNotFind:
    def test_a_computed_return_is_ordinary_control_flow(self):
        assert _branches("def f(x):\n    if x:\n        return compute(x)\n    return None\n") == []

    def test_a_multi_statement_guard_is_not_a_fallback(self):
        src = "def f(x):\n    if not x:\n        log()\n        return True\n    return g(x)\n"
        assert _branches(src) == []

    def test_a_plain_if_without_return(self):
        assert _branches("def f(x):\n    if x:\n        g()\n") == []


class TestUnexecuted:
    """The join against coverage data — where a wrong answer would be silent."""

    def _run(self, tmp_path: Path, src: str, executed: list[int], missing: list[int]):
        (tmp_path / "m.py").write_text(src)
        coverage = {"files": {"m.py": {"executed_lines": executed, "missing_lines": missing}}}
        return ebc.unexecuted(coverage, tmp_path)

    def test_reports_a_handler_the_suite_never_ran(self, tmp_path):
        found = self._run(tmp_path, "try:\n    f()\nexcept OSError:\n    g()\n", [2], [4])
        assert [b.line for b in found] == [4]

    def test_stays_silent_when_the_handler_was_executed(self, tmp_path):
        assert self._run(tmp_path, "try:\n    f()\nexcept OSError:\n    g()\n", [2, 4], []) == []

    def test_a_line_coverage_never_tracked_is_not_evidence(self, tmp_path):
        # Neither executed nor missing: coverage.py had no opinion, so neither
        # do we. Counting it would inflate the baseline with phantoms.
        assert self._run(tmp_path, "try:\n    f()\nexcept OSError:\n    g()\n", [2], []) == []

    def test_a_file_coverage_names_but_the_tree_lacks_is_skipped(self, tmp_path):
        coverage = {"files": {"gone.py": {"executed_lines": [], "missing_lines": [1]}}}
        assert ebc.unexecuted(coverage, tmp_path) == []


class TestMergeCoverage:
    """Combining two lanes' coverage.json (#637).

    The motivating case: `finance_invoicing.void_invoice`'s
    ``except DBAPIError`` is exercised only by a real-Postgres trigger, so the
    Python job's own coverage.json (no Postgres, the module skips) reports it
    unexecuted, and only a second, pg-lane coverage.json shows it covered.
    """

    def _pg_only_branch_src(self):
        # Mirrors the shape of the real finding: an except clause reachable
        # only from a real-Postgres trigger refusal.
        return "try:\n    void_invoice()\nexcept DBAPIError:\n    raise Conflict()\n"

    def test_a_pg_only_branch_reads_unexecuted_from_the_python_job_alone(self, tmp_path):
        # BEFORE: only the Python job's coverage.json (no Postgres — the
        # DBAPIError branch never ran there, exactly as #637 describes).
        (tmp_path / "m.py").write_text(self._pg_only_branch_src())
        python_job_coverage = {"files": {"m.py": {"executed_lines": [2], "missing_lines": [4]}}}
        found = ebc.unexecuted(ebc.merge_coverage([python_job_coverage]), tmp_path)
        assert [b.line for b in found] == [4]

    def test_the_same_branch_reads_covered_once_the_rls_lane_is_merged_in(self, tmp_path):
        # AFTER: the RLS Tests lane's own coverage.json ran line 4 for real,
        # against a real trigger refusal. Merging it in must clear the finding
        # without needing the Python job's own coverage.json to change at all.
        (tmp_path / "m.py").write_text(self._pg_only_branch_src())
        python_job_coverage = {"files": {"m.py": {"executed_lines": [2], "missing_lines": [4]}}}
        rls_lane_coverage = {"files": {"m.py": {"executed_lines": [2, 4], "missing_lines": []}}}
        found = ebc.unexecuted(
            ebc.merge_coverage([python_job_coverage, rls_lane_coverage]), tmp_path
        )
        assert found == []

    def test_a_line_missing_in_one_report_but_executed_in_another_is_executed(self):
        merged = ebc.merge_coverage(
            [
                {"files": {"m.py": {"executed_lines": [2], "missing_lines": [4]}}},
                {"files": {"m.py": {"executed_lines": [4], "missing_lines": [2]}}},
            ]
        )
        assert merged["files"]["m.py"]["executed_lines"] == [2, 4]
        assert merged["files"]["m.py"]["missing_lines"] == []

    def test_a_file_present_in_only_one_report_still_carries_through(self):
        merged = ebc.merge_coverage(
            [
                {"files": {"only_in_a.py": {"executed_lines": [1], "missing_lines": [2]}}},
                {"files": {"only_in_b.py": {"executed_lines": [5], "missing_lines": []}}},
            ]
        )
        assert set(merged["files"]) == {"only_in_a.py", "only_in_b.py"}
        assert merged["files"]["only_in_a.py"]["missing_lines"] == [2]

    def test_a_single_report_merges_to_itself(self):
        # The identity case, asserted explicitly: the default single-`--coverage`
        # path (unchanged since #956) must behave exactly as before this change.
        one = {"files": {"m.py": {"executed_lines": [2], "missing_lines": [4]}}}
        assert ebc.merge_coverage([one]) == one

    def test_no_reports_merges_to_an_empty_files_map(self):
        assert ebc.merge_coverage([]) == {"files": {}}


class TestMainCombinesMultipleCoverageArgs:
    """`--coverage` repeated on the CLI, end to end through main()."""

    def _write(self, tmp_path: Path, name: str, coverage: dict) -> Path:
        p = tmp_path / name
        p.write_text(json.dumps(coverage))
        return p

    def test_a_single_run_with_only_the_python_jobs_coverage_reports_the_finding(
        self, tmp_path, monkeypatch, capsys
    ):
        monkeypatch.setattr(ebc, "REPO_ROOT", tmp_path)
        monkeypatch.setattr(ebc, "BASELINE", tmp_path / "absent-baseline.json")
        (tmp_path / "m.py").write_text(
            "try:\n    void_invoice()\nexcept DBAPIError:\n    raise Conflict()\n"
        )
        cov = self._write(
            tmp_path,
            "python-job-coverage.json",
            {"files": {"m.py": {"executed_lines": [2], "missing_lines": [4]}}},
        )
        monkeypatch.setattr("sys.argv", ["x", "--check", "--coverage", str(cov)])
        assert ebc.main() == 0  # no baseline yet, so it reports rather than fails
        assert "m.py:4" in capsys.readouterr().out

    def test_passing_both_lanes_coverage_clears_the_pg_only_finding(
        self, tmp_path, monkeypatch, capsys
    ):
        monkeypatch.setattr(ebc, "REPO_ROOT", tmp_path)
        monkeypatch.setattr(ebc, "BASELINE", tmp_path / "absent-baseline.json")
        (tmp_path / "m.py").write_text(
            "try:\n    void_invoice()\nexcept DBAPIError:\n    raise Conflict()\n"
        )
        python_cov = self._write(
            tmp_path,
            "python-job-coverage.json",
            {"files": {"m.py": {"executed_lines": [2], "missing_lines": [4]}}},
        )
        rls_cov = self._write(
            tmp_path,
            "rls-coverage.json",
            {"files": {"m.py": {"executed_lines": [2, 4], "missing_lines": []}}},
        )
        monkeypatch.setattr(
            "sys.argv",
            ["x", "--check", "--coverage", str(python_cov), "--coverage", str(rls_cov)],
        )
        assert ebc.main() == 0
        out = capsys.readouterr().out
        assert "m.py:4" not in out
        assert "unexecuted error branches: 0" in out

    def test_a_missing_extra_coverage_path_is_noted_but_not_fatal(
        self, tmp_path, monkeypatch, capsys
    ):
        monkeypatch.setattr(ebc, "REPO_ROOT", tmp_path)
        monkeypatch.setattr(ebc, "BASELINE", tmp_path / "absent-baseline.json")
        (tmp_path / "m.py").write_text("try:\n    f()\nexcept OSError:\n    g()\n")
        cov = self._write(
            tmp_path,
            "coverage.json",
            {"files": {"m.py": {"executed_lines": [2, 4], "missing_lines": []}}},
        )
        never_written = tmp_path / "rls-coverage.json"
        monkeypatch.setattr(
            "sys.argv",
            ["x", "--check", "--coverage", str(cov), "--coverage", str(never_written)],
        )
        assert ebc.main() == 0
        err = capsys.readouterr().err
        assert str(never_written) in err
        assert "not found" in err


@pytest.mark.skipif(
    not ebc.BASELINE.is_file(),
    reason=(
        "no error-branch baseline in this repo yet — it is a measurement of the repo it "
        "lives in, so a core upgrade cannot ship one (#983). Take it with:\n"
        f"  {ebc.BOOTSTRAP_COMMANDS[0]}\n"
        f"  {ebc.BOOTSTRAP_COMMANDS[1]}"
    ),
)
class TestBaseline:
    """Assertions about the committed baseline — which not every repo has.

    This test file is template-owned and arrives in every instance through
    ``biffo core upgrade``; ``docs/practices/error-branch-baseline.json`` is
    correctly NOT template-owned, because it measures the tree it sits in. So the
    test travels and its data cannot, and these two used to raise a bare
    ``FileNotFoundError`` in every instance that upgraded past the version which
    introduced them (#983) — naming neither the analyser's ``--write`` flag nor
    the ``pytest --cov --cov-report=json`` run it needs first.

    Skipped rather than failed where no baseline exists. Where one does — this
    repo, and any instance that has taken the measurement — it is asserted on
    exactly as before, so the ratchet is not loosened by a single notch.
    """

    def test_the_committed_baseline_parses_and_is_a_real_measurement(self):
        data = json.loads(ebc.BASELINE.read_text())
        assert data["total"] == len(data["branches"])
        # A zero baseline would mean the analyser found nothing, which for a
        # tree this size means it is broken rather than that the tree is clean.
        assert data["total"] > 0

    def test_every_baselined_branch_names_a_file_that_still_exists(self):
        data = json.loads(ebc.BASELINE.read_text())
        root = ebc.REPO_ROOT
        missing = [k for k in data["branches"] if not (root / k.split(":")[0]).is_file()]
        assert missing == [], f"baseline references deleted files: {missing}"


class TestNoBaselineYet:
    """A ratchet with no prior position starts; it does not block (#983).

    Every instance reaches this gate having never taken the measurement, because
    the baseline is not distributable. Treating "never measured" as "measured
    zero" made every branch it found look newly added, and red-lit the
    ``Error-branch coverage`` CI step on every core upgrade with a message
    ("Either cover it, or run --write to accept it deliberately") that never
    mentioned the file was simply absent.
    """

    def _coverage(self, tmp_path: Path) -> Path:
        (tmp_path / "m.py").write_text("try:\n    f()\nexcept OSError:\n    g()\n")
        cov = tmp_path / "coverage.json"
        cov.write_text(
            json.dumps({"files": {"m.py": {"executed_lines": [2], "missing_lines": [4]}}})
        )
        return cov

    def _run(self, tmp_path, monkeypatch, baseline: Path) -> int:
        monkeypatch.setattr(ebc, "REPO_ROOT", tmp_path)
        monkeypatch.setattr(ebc, "BASELINE", baseline)
        cov = self._coverage(tmp_path)
        monkeypatch.setattr("sys.argv", ["x", "--check", "--coverage", str(cov)])
        return ebc.main()

    def test_check_reports_and_passes_when_no_baseline_exists(self, tmp_path, monkeypatch, capsys):
        assert self._run(tmp_path, monkeypatch, tmp_path / "absent.json") == 0
        out = capsys.readouterr()
        # The finding is still printed — starting the ratchet is not hiding it.
        assert "m.py:4" in out.out
        assert "no baseline yet" in out.out

    def test_the_message_names_both_bootstrap_commands_in_order(
        self, tmp_path, monkeypatch, capsys
    ):
        # The whole cost of #983 was that the failure named neither command, and
        # the --cov run is not guessable from "FileNotFoundError".
        self._run(tmp_path, monkeypatch, tmp_path / "absent.json")
        err = capsys.readouterr().err
        assert "pytest --cov --cov-report=json" in err
        assert "error_branch_coverage.py --write" in err
        assert err.index("pytest --cov") < err.index("--write")

    def test_a_present_baseline_still_fails_on_growth(self, tmp_path, monkeypatch, capsys):
        # The anti-fail-open control. "Missing" must be the only state that
        # passes; a baseline that exists and says zero still ratchets, or this
        # fix would have quietly switched the gate off everywhere.
        baseline = tmp_path / "baseline.json"
        baseline.write_text(json.dumps({"total": 0, "branches": []}))
        assert self._run(tmp_path, monkeypatch, baseline) == 1
        assert "added with no test exercising them" in capsys.readouterr().err


def test_the_analyser_refuses_to_pass_without_coverage_data(tmp_path, monkeypatch, capsys):
    """No coverage.json must be an error, not an empty clean report."""
    monkeypatch.setattr("sys.argv", ["x", "--check", "--coverage", str(tmp_path / "nope.json")])
    with pytest.raises(SystemExit) as exc:
        raise SystemExit(ebc.main())
    assert exc.value.code == 2
    assert "No coverage data" in capsys.readouterr().err
