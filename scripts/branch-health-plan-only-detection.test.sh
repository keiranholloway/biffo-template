#!/usr/bin/env sh
#
# Guard for the branch-health.sh half of #1582.
#
# #1678 fixed the Actions-UI half: a plan-only `Deploy Infrastructure`
# dispatch now gets `run-name: ... PLAN ONLY dev (nothing applied)` instead
# of looking identical to a real apply. `branch-health.sh` — the tool
# `practices-daily.sh` uses across the whole estate to answer "is the
# integration branch actually healthy" — never saw that fix: its summary
# query requests `workflowName,status,conclusion,headSha,createdAt,url,event`
# and NOT `displayTitle`, so it still classifies that run as a plain `ok`.
# `conclusion` alone can never discriminate the two, because a plan-only
# dispatch's plan step genuinely succeeds — that is the whole reason #1582
# exists.
#
# This fixture is not invented: it is the real `gh run list` shape for run
# 32553786917 in this repo, captured 2026-08-22 via
#   gh run view 32553786917 --json displayTitle,conclusion,event,workflowName
# which returned:
#   {"conclusion":"success","displayTitle":"Deploy Infrastructure — PLAN ONLY dev (nothing applied)", ...}
#
# Run: sh scripts/branch-health-plan-only-detection.test.sh
# Exit 0 = guard holds (a plan-only run is never rendered as plain `ok`).
# Exit 1 = branch-health.sh regressed (or reproduces the pre-fix bug).

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
STUB_DIR=$(mktemp -d)
trap 'rm -rf "$STUB_DIR"' EXIT

# --- Fake `gh` -------------------------------------------------------------
#
# Only the summary `gh run list` call is exercised: the run's conclusion is
# "success", so `$failed` stays empty and branch-health.sh never reaches its
# per-workflow history call (that call only fires for failed workflows).
# `--branch dev` is passed explicitly on the command line below, so the
# `gh repo view` default-branch lookup is never reached either.

cat > "$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env sh
set -u

if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  # One workflow, one run: a workflow_dispatch left at the default `action:
  # plan`, reported exactly as `gh run view 32553786917` returns it for real
  # in this repo — conclusion "success", displayTitle carrying the #1678
  # run-name fix's plan-only marker.
  printf 'success\tDeploy Infrastructure\t80ce6944\t2026-08-22T05:13\thttps://github.com/keiranholloway/biffo-template/actions/runs/32553786917\tworkflow_dispatch\tDeploy Infrastructure — PLAN ONLY dev (nothing applied)\n'
  exit 0
fi

echo "unexpected gh invocation: $*" >&2
exit 1
STUB
chmod +x "$STUB_DIR/gh"

# --- Run branch-health.sh with the stub on PATH -----------------------------

raw_output=$(PATH="$STUB_DIR:$PATH" BRANCH_HEALTH_NO_DESKTOP_ALERT=1 sh "$REPO_ROOT/scripts/branch-health.sh" --branch dev 2>&1)
status=$?

# Strip ANSI colour codes before matching — the real output wraps every
# label in `printf '\033[3Nm'` ... `\033[0m`, so a plain-text pattern must
# not have to thread that escape sequence to match a whole word.
output=$(printf '%s' "$raw_output" | sed 's/\x1b\[[0-9;]*m//g')

fail=0

# The property under test: a plan-only run must never appear on a plain `ok`
# line. A skim-reader distinguishes rows by their left-hand label, not by
# reading every title, so the label itself must say it did not apply.
if printf '%s' "$output" | grep -qE '^\s*ok\s+Deploy Infrastructure\s*$'; then
  echo "FAIL: branch-health.sh rendered the plan-only run as plain 'ok'." >&2
  echo "  A plan-only Deploy Infrastructure dispatch is indistinguishable from a real apply (#1582)." >&2
  fail=1
fi

# It must still say SOMETHING about this workflow — silence would just move
# the bug from "looks healthy" to "invisible".
if ! printf '%s' "$output" | grep -qi "Deploy Infrastructure"; then
  echo "FAIL: branch-health.sh dropped the Deploy Infrastructure workflow from its output entirely." >&2
  fail=1
fi

# A plan-only dispatch is not itself a branch failure (the plan step really
# did succeed) — it must not be reported as exit 1 "something failed".
if [ "$status" -eq 1 ]; then
  echo "FAIL: expected the plan-only run to not be reported as a branch failure (exit 1)." >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "--- full output ---" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

echo "PASS: a plan-only Deploy Infrastructure run is never rendered as plain 'ok'."
exit 0
