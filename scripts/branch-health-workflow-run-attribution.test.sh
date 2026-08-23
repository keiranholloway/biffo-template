#!/usr/bin/env sh
#
# Guard for #1463: branch-health.sh must never assert "has been failing
# since <sha>" for a workflow_run-triggered workflow, because that sha is
# the run's own ambient headSha — for a workflow_run trigger that is not
# reliably the commit the run evaluated (see the long comment in
# branch-health.sh's "Who actually broke it" section for the reproduction).
#
# This stubs `gh` on PATH with a fake that returns canned JSON for exactly
# the two `gh run list` calls branch-health.sh makes, modelled on a real
# failing run observed in this repo (workflow "Error-branch coverage gate",
# event workflow_run, reported headSha f0d697e1 which is NOT the commit the
# run actually evaluated — see #1463). It also stubs `gh repo view` (for the
# default branch) and `notify-send` absence is fine (branch-health.sh no-ops
# without it).
#
# Enumerable rather than per-case: this asserts a PROPERTY that must hold for
# ANY workflow_run-triggered failure, not a fixed string for this one
# workflow — "no confident single-sha attribution line for a workflow_run
# entry" — so a future workflow_run workflow added to the fixture is covered
# without touching the assertion.
#
# Run: sh scripts/branch-health-workflow-run-attribution.test.sh
# Exit 0 = guard holds. Exit 1 = branch-health.sh regressed (or the fixture
# itself is broken — read the diff printed on failure).
#
# `set -uo pipefail` (both here and in the stub `gh` below) was dropped to
# `set -u` for #1705's guard-wiring audit: this file went eight-plus cycles
# with zero callers, so nothing ever executed it under a real dash, and
# this workstation's own dash (Ubuntu 26.04, 0.5.12-12ubuntu3) silently
# accepts `set -o pipefail` where the CI runner's (ubuntu-24.04,
# 0.5.12-6ubuntu5) rejects it at RUNTIME with "Illegal option -o pipefail"
# -- a syntax check (`dash -n`) cannot catch this, only real execution can.
# Neither pipeline in this file (`printf ... | grep -q ...`, twice below)
# depends on pipefail: in both, the final command (grep) already determines
# the `if`'s result and printf cannot itself fail, so dropping pipefail
# loses no coverage. Verified by executing this file under a genuine
# ubuntu-24.04 dash (`docker run ubuntu:24.04`, dash 0.5.12-6ubuntu5), not
# just `dash -n`.
#
# The `branch-health.sh` invocation below was also changed from
# `sh "$REPO_ROOT/scripts/branch-health.sh"` to invoking it directly as an
# executable -- the same fix branch-health-plan-only-detection.test.sh
# already carries and explains at more length. branch-health.sh declares
# `#!/usr/bin/env bash` and needs it (it has its own `set -uo pipefail`);
# forcing it through `sh` hands it to dash instead of its own shebang and
# hits the identical "Illegal option -o pipefail" death, before the fixture
# proves anything.

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
STUB_DIR=$(mktemp -d)
trap 'rm -rf "$STUB_DIR"' EXIT

# --- Fake `gh` -----------------------------------------------------------
#
# branch-health.sh calls `gh run list` twice (summary, then per-failed-name
# history) and `gh repo view` once (default branch). Everything else it
# might call (gh api, for --quiet notify path) is not reached in this
# fixture because QUIET is not set and notify-send is absent, so _notify
# no-ops before touching gh.

cat > "$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env sh
set -u

case "$1 $2" in
  "repo view")
    echo "dev"
    exit 0
    ;;
esac

if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  # Distinguish the summary call (no --workflow) from the per-name history
  # call (--workflow "<name>") by scanning the args.
  workflow=""
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--workflow" ]; then workflow="$a"; fi
    prev="$a"
  done

  if [ -z "$workflow" ]; then
    # Summary: one workflow, one failing run, workflow_run-triggered.
    # headSha here (f0d697e1) is the run's own ambient checkout ref — real
    # data from this repo's history — and is NOT the commit this run
    # actually evaluated (0c077cf0, per the run's own job log). A correct
    # branch-health.sh must not assert f0d697e1 "has been failing since".
    printf 'failure\tError-branch coverage gate\tf0d697e1\t2026-08-10T16:54\thttps://example/runs/1\tworkflow_run\n'
    exit 0
  fi

  # Per-name history call for "Error-branch coverage gate": two failing runs
  # back to back, newest first already handled by the script's own sort.
  echo '[
    {"conclusion":"failure","headSha":"f0d697e1b001c9918467b52664f80c16acdf7754","createdAt":"2026-08-10T16:54:00Z","displayTitle":"fix(deploy): package plugins that declare only admin_ingress (#1466)","url":"https://example/runs/1"},
    {"conclusion":"failure","headSha":"8a4e365a233508afdfe9bc562bc246577f26a977","createdAt":"2026-08-10T16:39:00Z","displayTitle":"some earlier commit","url":"https://example/runs/2"}
  ]'
  exit 0
fi

echo "unexpected gh invocation: $*" >&2
exit 1
STUB
chmod +x "$STUB_DIR/gh"

# --- Run branch-health.sh with the stub on PATH ---------------------------

output=$(PATH="$STUB_DIR:$PATH" BRANCH_HEALTH_NO_DESKTOP_ALERT=1 "$REPO_ROOT/scripts/branch-health.sh" --branch dev 2>&1)
status=$?

fail=0

# The property under test: no unqualified "has been failing since <sha>"
# line for the workflow_run-triggered workflow. (A push-triggered workflow
# is untouched by this guard — see the "regular" fixture note below if one
# is ever added.)
if printf '%s' "$output" | grep -q "has been failing since"; then
  echo "FAIL: branch-health.sh asserted an unqualified 'has been failing since' for a workflow_run-triggered run." >&2
  echo "  A workflow_run run's headSha is not reliably the evaluated commit (#1463)." >&2
  fail=1
fi

# It must still surface the failure — silence would be a worse regression
# than a wrong attribution. Expect the hedge language this fix adds.
if ! printf '%s' "$output" | grep -q "Cannot"; then
  echo "FAIL: branch-health.sh did not hedge attribution for the workflow_run-triggered failure." >&2
  echo "  Expected output to explain it cannot attribute a single commit." >&2
  fail=1
fi

if [ "$status" -ne 1 ]; then
  echo "FAIL: expected exit 1 (branch is red) — got $status." >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "--- full output ---" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

echo "PASS: workflow_run-triggered failure is reported without a confident single-sha attribution."
exit 0
