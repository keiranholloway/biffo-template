#!/bin/sh
#
# Re-run a workflow run's failed jobs, but ONLY when the runner died (#1997).
#
# A reclaimed self-hosted spot runner produces a check whose conclusion is
# `failure` -- identical, at the conclusion level, to a genuinely broken test.
# The only thing that distinguishes them is the annotation the Actions service
# writes on the dead job:
#
#     The self-hosted runner lost communication with the server.
#
# Nothing in `statusCheckRollup` carries that, and neither does the check run's
# own `output.summary` (verified: null on all three of tabsii-platform#1420's
# failed checks). It has to be fetched per failed job, which is what this does.
#
# ## Why this is worth a workflow
#
# Measured on tabsii-com/tabsii-platform via CloudTrail `BidEvictedEvent`, the
# seven days to 2026-09-09: 50 instances reclaimed, 22 of them in the final 36
# hours. The two long lanes run 17-20 minutes, so each is exposed for its whole
# runtime, and the same pair died to eviction five times in twelve hours across
# three unrelated PRs. Every one of those sat red until a person looked.
#
# ## What it deliberately does NOT do
#
# It does not re-run a failure it cannot attribute to the runner. A red test
# stays red -- that is the whole point, and the direction the uncertainty is
# resolved in: "could not tell" means "leave it alone", never "re-run it".
#
# It does not run on deploy workflows. A deploy killed part-way is not safely
# re-runnable without knowing what it had already applied, and that judgement
# belongs to a person. The caller's `workflows:` list is what enforces this.
#
# ## POSIX sh; validate with BOTH `dash -n` and `bash -n`.
#
# Usage:  sh scripts/rerun-on-runner-loss.sh <run-id>
# Needs:  GITHUB_REPOSITORY, and a `gh` authenticated with `actions: write`.
set -eu

RUN_ID="${1:?usage: rerun-on-runner-loss.sh <run-id>}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"

# GitHub's own wording, matched as a FIXED string (grep -F), not a pattern. If
# the service ever rewords it this script stops re-running things, which is the
# safe direction to fail in -- the unsafe one would be a loose pattern that
# starts matching real test output and re-runs genuine failures for ever.
MARKER='lost communication with the server'

# EXIT CODES, and why "declined" is not an error:
#   0  acted, or correctly declined -- both are this script working as intended
#   1  could not tell (an API read failed). LOUD on purpose: a silent inability
#      to read is how a guard turns into decoration, so it fails the job rather
#      than quietly never re-running anything again.
#   2  the re-run itself was refused by the API
EXIT_UNDETERMINED=1
EXIT_RERUN_FAILED=2

say() { printf '%s\n' "$*"; }

run_json=$(gh api "repos/$REPO/actions/runs/$RUN_ID" \
             --jq '[(.run_attempt|tostring), .conclusion] | @tsv' 2>/dev/null) || {
  say "could not read run $RUN_ID in $REPO — cannot tell whether the runner died, so nothing was re-run."
  exit "$EXIT_UNDETERMINED"
}
attempt=$(printf '%s' "$run_json" | cut -f1)
conclusion=$(printf '%s' "$run_json" | cut -f2)

# THE RECURSION GUARD AND THE ONCE-ONLY RULE ARE THE SAME CHECK. A re-run is
# attempt 2, so a run this script has already acted on can never satisfy this
# again -- there is no counter to keep and no state to store. The caller's `if:`
# asserts the same thing; it is repeated here so the script is correct when
# invoked by hand (`workflow_dispatch`) too, rather than relying on its caller.
if [ "$attempt" != "1" ]; then
  say "run $RUN_ID is attempt $attempt — already re-run once; declining. A second identical failure is evidence, not noise."
  exit 0
fi

if [ "$conclusion" != "failure" ]; then
  say "run $RUN_ID concluded '$conclusion', not 'failure' — nothing to re-run."
  exit 0
fi

# A job id IS its check-run id (verified against tabsii-platform#1420: job
# 102345626337 and check-run 102345626337 are the same object), so the failed
# jobs can be listed and their annotations fetched without a second lookup to
# map between the two.
jobs=$(gh api "repos/$REPO/actions/runs/$RUN_ID/jobs?per_page=100" \
         --jq '.jobs[]?|select(.conclusion=="failure")|.id' 2>/dev/null) || {
  say "could not list failed jobs for run $RUN_ID — cannot tell whether the runner died, so nothing was re-run."
  exit "$EXIT_UNDETERMINED"
}

if [ -z "$jobs" ]; then
  say "run $RUN_ID failed but reports no failed jobs — nothing to attribute, nothing re-run."
  exit 0
fi

lost=""
for job in $jobs; do
  ann=$(gh api "repos/$REPO/check-runs/$job/annotations" --jq '.[]?.message' 2>/dev/null) || {
    say "could not read annotations for job $job — cannot tell whether the runner died, so nothing was re-run."
    exit "$EXIT_UNDETERMINED"
  }
  if printf '%s\n' "$ann" | grep -qF "$MARKER"; then
    lost="$job"
    say "job $job: the runner lost communication with the server — this is reclaimed capacity, not a broken change."
    break
  fi
done

if [ -z "$lost" ]; then
  say "run $RUN_ID failed, and no failed job blames a lost runner — leaving it red. A real failure must stay red."
  exit 0
fi

# `gh run rerun --failed` re-runs EVERY failed job in the run, not only the one
# that named a lost runner. That is deliberate: a run killed by a pool-wide
# reclamation routinely loses several jobs at the same second (seven instances
# went at 2026-09-09T05:22:29Z), and any genuinely-failing job swept along with
# them simply fails again in seconds. Re-running one job at a time would need a
# second pass to catch the rest.
#
# EXIT CODE, NOT OUTPUT. `gh run rerun` prints nothing on success when stdout is
# not a terminal, so a caller checking for output reads every success as a
# failure (biffo-fleet#77 is that exact mistake, filed).
if gh run rerun "$RUN_ID" --repo "$REPO" --failed; then
  say "re-ran the failed jobs of run $RUN_ID once."
  exit 0
fi

say "re-run of run $RUN_ID was refused."
exit "$EXIT_RERUN_FAILED"
