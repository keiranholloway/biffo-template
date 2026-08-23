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
#
# Invoked as an executable, not `sh <path>` — branch-health.sh declares
# `#!/usr/bin/env bash` and genuinely needs it (`set -uo pipefail`). Forcing
# it through an explicit `sh` prefix throws away its own shebang and hands it
# to whatever `sh` resolves to instead, which is dash on both this
# workstation and the CI runner. The two dash builds disagree on `set -o
# pipefail`: this workstation's (Ubuntu 26.04) silently tolerates it, so this
# test previously passed here while dying on the runner's dash 0.5.12
# (`Illegal option -o pipefail`) with no output for the assertions below to
# read — the exact "dropped the workflow entirely" failure this test is
# supposed to catch, misattributed to branch-health.sh's own logic. Direct
# invocation lets the OS dispatch to bash per the shebang, matching how the
# script is written and how `dash -n`/`bash -n` treat it, on both machines.
raw_output=$(PATH="$STUB_DIR:$PATH" BRANCH_HEALTH_NO_DESKTOP_ALERT=1 "$REPO_ROOT/scripts/branch-health.sh" --branch dev 2>&1)
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

# --- Scenario 2: the new `deploy-infra-plan.yml` workflow (#1702) ----------
#
# #1700 made `deploy-infra.yml`'s `action` input required, default-less and
# `apply`-only (#1701's 422), so it can never again produce the scenario-1
# ambiguous "success that applied nothing" run — a plan preview now lives in
# its own workflow, `.github/workflows/deploy-infra-plan.yml`, which has NO
# apply job at all. Its `run-name` is:
#
#   Deploy Infrastructure Plan — ${{ github.event.inputs.environment }} (preview only)
#
# and it does NOT contain the literal substring "PLAN ONLY" anywhere — the
# scenario-1 marker was specific to `deploy-infra.yml`'s own run-name
# template (`format('PLAN ONLY {0} (nothing applied)', ...)`), and this is a
# different workflow with a different template. Pre-fix, branch-health.sh's
# ONLY plan-only signal is that title substring, so this run falls straight
# into the plain `ok` bucket — indistinguishable from a real apply, which is
# the exact bug #1582 exists to prevent, now reopened by a workflow #1582
# never saw.
#
# No live run of this workflow exists in this repo yet (BIFFO_DEPLOY_ENABLED
# is unset in biffo-template itself, and `gh run list --workflow
# deploy-infra-plan.yml` returns `[]` here as of 2026-08-23) — it is
# workflow_dispatch-only and nobody has triggered it. So this fixture is NOT
# a live capture like scenario 1's; it is built directly from the workflow
# file's own literal `name:` (line 1) and `run-name:` template (line 25) in
# `.github/workflows/deploy-infra-plan.yml`, with `environment: dev`
# substituted for the input. If those literals ever change, copy the new
# ones from the workflow file — do not reword this fixture by hand.

cat > "$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env sh
set -u

if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  # workflowName is the workflow's own `name:` (structural, line 1 of
  # deploy-infra-plan.yml). displayTitle is its run-name template rendered
  # for `environment: dev` — no "PLAN ONLY" substring anywhere in either.
  printf 'success\tDeploy Infrastructure Plan\t80ce6944\t2026-08-23T09:00\thttps://github.com/keiranholloway/biffo-template/actions/runs/99999999999\tworkflow_dispatch\tDeploy Infrastructure Plan — dev (preview only)\n'
  exit 0
fi

echo "unexpected gh invocation: $*" >&2
exit 1
STUB
chmod +x "$STUB_DIR/gh"

raw_output2=$(PATH="$STUB_DIR:$PATH" BRANCH_HEALTH_NO_DESKTOP_ALERT=1 "$REPO_ROOT/scripts/branch-health.sh" --branch dev 2>&1)
status2=$?
output2=$(printf '%s' "$raw_output2" | sed 's/\x1b\[[0-9;]*m//g')

fail2=0

# The property under test: a successful `Deploy Infrastructure Plan` run
# must never appear on a plain `ok` line either — same reasoning as scenario
# 1, different workflow, no title marker to lean on this time.
if printf '%s' "$output2" | grep -qE '^\s*ok\s+Deploy Infrastructure Plan\s*$'; then
  echo "FAIL: branch-health.sh rendered a successful 'Deploy Infrastructure Plan' run as plain 'ok'." >&2
  echo "  This workflow (#1702) has no apply job at all and never emits a 'PLAN ONLY' title." >&2
  fail2=1
fi

if ! printf '%s' "$output2" | grep -qi "Deploy Infrastructure Plan"; then
  echo "FAIL: branch-health.sh dropped the Deploy Infrastructure Plan workflow from its output entirely." >&2
  fail2=1
fi

if [ "$status2" -eq 1 ]; then
  echo "FAIL: expected a successful plan-only run to not be reported as a branch failure (exit 1)." >&2
  fail2=1
fi

if [ "$fail2" -ne 0 ]; then
  echo "--- full output (scenario 2) ---" >&2
  printf '%s\n' "$output2" >&2
  exit 1
fi

echo "PASS: a successful 'Deploy Infrastructure Plan' run is never rendered as plain 'ok'."
exit 0
