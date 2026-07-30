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


class TestBaseline:
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


def test_the_analyser_refuses_to_pass_without_coverage_data(tmp_path, monkeypatch, capsys):
    """No coverage.json must be an error, not an empty clean report."""
    monkeypatch.setattr("sys.argv", ["x", "--check", "--coverage", str(tmp_path / "nope.json")])
    with pytest.raises(SystemExit) as exc:
        raise SystemExit(ebc.main())
    assert exc.value.code == 2
    assert "No coverage data" in capsys.readouterr().err
