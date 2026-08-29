"""Execute the REAL shell embedded in ci.yml's "Error-branch coverage" step.

Not a helper that is imported for its own sake -- this exists because the
existing suite in ``test_second_coverage_lane.py`` proved unable to catch a
behavioural regression (#1749): every assertion there greps the YAML text of
the step, so a mutation that changes *what the shell does* while leaving the
grepped substrings intact passes silently. Verified: inverting
``if [ "${present:-false}" != "true" ]`` to ``=`` -- the one comparison that
decides which of the gate's two code paths runs -- left all 17 existing tests
green.

The fix is to run the step's shell, not read it. ``extract_gate_script``
pulls the literal ``run:`` block out of ci.yml via ``yaml.safe_load`` (a
structural extraction of the exact bytes the runner executes, not a text
search), and ``run_gate_script`` executes it under ``bash`` -- the shell
GitHub Actions actually uses for an unqualified ``run:`` step on an Ubuntu
runner -- with only its network/VCS boundary faked out:

- ``gh`` and ``git`` are shadowed on ``PATH`` by tiny scripts under this
  module's control, driven entirely by environment variables the caller sets.
  Everything else the step calls (``sed``, ``jq``, ``date``, ``sleep``,
  ``python3``) is the real binary.
- The two "trusted copies" the step fetches via ``git show FETCH_HEAD:...``
  are replaced by small, env-driven Python stand-ins
  (``_STUB_LANE_PY`` / ``_STUB_COVCHECK_PY``) rather than the real
  ``scripts/*.py`` -- this test is about the shell's *control flow*, not
  about re-testing the resolver or the coverage checker, which already have
  their own unit tests elsewhere.

The real polling loop, the real ``if [ "${present:-false}" != "true" ]``
branch, the real ``sed`` extraction and the real timeout path all run for
real; only their inputs are canned.
"""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

import yaml

_ROOT = Path(__file__).resolve().parents[3]
_CI_YML = _ROOT / ".github" / "workflows" / "ci.yml"

_GATE_STEP_NAME = "Error-branch coverage"

# Env-driven stand-ins for the two "trusted copies" the step fetches via
# `git show`. Behaviour is controlled entirely by env vars set by the test,
# not by which fixture file is served -- there is only ever one of each.
_STUB_LANE_PY = """\
import os, sys
sys.stdout.write(f"present={os.environ.get('STUB_LANE_PRESENT', 'false')}\\n")
name = os.environ.get("STUB_LANE_NAME", "")
if name:
    sys.stdout.write(f"name={name}\\n")
    sys.stdout.write("path=.github/workflows/stub-lane.yml\\n")
sys.exit(int(os.environ.get("STUB_LANE_EXIT", "0")))
"""

_STUB_COVCHECK_PY = """\
import os, sys
sys.exit(int(os.environ.get("STUB_COVERAGE_EXIT", "0")))
"""

# `git` -- only `fetch` (no-op, controllable exit) and `show FETCH_HEAD:scripts/<f>`
# (serves one of the two stand-ins above, or fails) are ever called by the step.
_GIT_STUB = """\
#!/usr/bin/env bash
set -u
case "$1" in
  fetch)
    exit "${STUB_GIT_FETCH_EXIT:-0}"
    ;;
  show)
    case "$2" in
      FETCH_HEAD:scripts/second_coverage_lane.py)
        [ "${STUB_GIT_SHOW_LANE_EXIT:-0}" = "0" ] || exit 1
        cat "$STUB_FIXTURES_DIR/stub_lane.py"
        ;;
      FETCH_HEAD:scripts/error_branch_coverage.py)
        [ "${STUB_GIT_SHOW_COV_EXIT:-0}" = "0" ] || exit 1
        cat "$STUB_FIXTURES_DIR/stub_covcheck.py"
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  *)
    exit 1
    ;;
esac
"""

# `gh` -- the three calls the step makes: resolve the default branch, list
# runs for a head sha, and download the lane's coverage artefact.
_GH_STUB = """\
#!/usr/bin/env bash
set -u
if [ "$1" = "api" ]; then
  case "$2" in
    repos/*/actions/runs\\?*)
      [ "${STUB_GH_RUNS_EXIT:-0}" = "0" ] || exit 1
      cat "$STUB_RUNS_JSON"
      ;;
    repos/*)
      [ "${STUB_GH_DEFAULT_BRANCH_EXIT:-0}" = "0" ] || exit 1
      printf '%s\\n' "${STUB_DEFAULT_BRANCH:-dev}"
      ;;
    *)
      exit 1
      ;;
  esac
elif [ "$1" = "run" ] && [ "$2" = "download" ]; then
  [ "${STUB_GH_DOWNLOAD_EXIT:-0}" = "0" ] || exit 1
  dir="cov-lane"
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--dir" ]; then dir="$a"; fi
    prev="$a"
  done
  mkdir -p "$dir"
  printf '{}' > "$dir/rls-coverage.json"
else
  exit 1
fi
"""


def extract_gate_script(ci_text: str | None = None) -> str:
    """The literal `run:` block of the "Error-branch coverage" step.

    Pulled via `yaml.safe_load`, not a text search -- this is a structural
    extraction of the exact bash the runner executes for that step, byte for
    byte, including the trailing newline the YAML block scalar carries.
    """
    doc = yaml.safe_load(ci_text if ci_text is not None else _CI_YML.read_text())
    for step in doc["jobs"]["python"]["steps"]:
        if step.get("name") == _GATE_STEP_NAME:
            run = step.get("run")
            assert isinstance(run, str), f"{_GATE_STEP_NAME!r} step has no `run:` block"
            return run
    raise AssertionError(f"no step named {_GATE_STEP_NAME!r} in jobs.python.steps")


def _make_executable(path: Path, content: str) -> None:
    path.write_text(content)
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def run_gate_script(
    script: str,
    tmp_path: Path,
    *,
    lane_present: bool,
    lane_name: str = "",
    lane_exit: int = 0,
    coverage_exit: int = 0,
    runs_json: str = '{"workflow_runs": []}',
    lane_wait_seconds: str = "2",
    lane_poll_seconds: str = "1",
    default_branch: str = "dev",
    default_branch_exit: int = 0,
    fetch_exit: int = 0,
    show_lane_exit: int = 0,
    show_cov_exit: int = 0,
    runs_exit: int = 0,
    download_exit: int = 0,
) -> dict[str, str]:
    """Run `script` (as extracted by `extract_gate_script`) under bash, with
    `gh`/`git` shadowed and the two trusted copies replaced by stand-ins.

    Returns the GITHUB_OUTPUT key/value pairs the script actually wrote,
    plus `_returncode`, `_stdout` and `_stderr` for callers that need them.
    """
    workdir = tmp_path / "work"
    workdir.mkdir()
    (workdir / "coverage.json").write_text("{}")

    fixtures = tmp_path / "fixtures"
    fixtures.mkdir()
    (fixtures / "stub_lane.py").write_text(_STUB_LANE_PY)
    (fixtures / "stub_covcheck.py").write_text(_STUB_COVCHECK_PY)

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _make_executable(bin_dir / "git", _GIT_STUB)
    _make_executable(bin_dir / "gh", _GH_STUB)

    runs_json_path = tmp_path / "runs.json"
    runs_json_path.write_text(runs_json)

    script_path = tmp_path / "gate_step.sh"
    script_path.write_text(script)

    github_output = workdir / "github_output.txt"
    github_output.write_text("")

    env = dict(os.environ)
    env.update(
        {
            "PATH": f"{bin_dir}:{env.get('PATH', '')}",
            "GH_TOKEN": "stub-token",
            "REPO": "acme/widgets",
            "SHA": "deadbeefcafef00dfeedfacecafebeef00000000",
            "LANE_WAIT_SECONDS": lane_wait_seconds,
            "LANE_POLL_SECONDS": lane_poll_seconds,
            "GITHUB_OUTPUT": str(github_output),
            "STUB_FIXTURES_DIR": str(fixtures),
            "STUB_LANE_PRESENT": "true" if lane_present else "false",
            "STUB_LANE_NAME": lane_name,
            "STUB_LANE_EXIT": str(lane_exit),
            "STUB_COVERAGE_EXIT": str(coverage_exit),
            "STUB_RUNS_JSON": str(runs_json_path),
            "STUB_DEFAULT_BRANCH": default_branch,
            "STUB_GH_DEFAULT_BRANCH_EXIT": str(default_branch_exit),
            "STUB_GH_RUNS_EXIT": str(runs_exit),
            "STUB_GIT_FETCH_EXIT": str(fetch_exit),
            "STUB_GIT_SHOW_LANE_EXIT": str(show_lane_exit),
            "STUB_GIT_SHOW_COV_EXIT": str(show_cov_exit),
            "STUB_GH_DOWNLOAD_EXIT": str(download_exit),
        }
    )

    # nosec B603 / noqa S603 — `bash` is resolved from PATH deliberately (it is
    # the shell GitHub Actions itself uses for this step), and every argument
    # is a path this test created under tmp_path. Nothing here originates from
    # request or user input.
    result = subprocess.run(  # noqa: S603
        ["bash", str(script_path)],  # noqa: S607  # nosec B603,B607
        cwd=workdir,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    outputs: dict[str, str] = {}
    for line in github_output.read_text().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            outputs[k] = v
    outputs["_returncode"] = str(result.returncode)
    outputs["_stdout"] = result.stdout
    outputs["_stderr"] = result.stderr
    return outputs
