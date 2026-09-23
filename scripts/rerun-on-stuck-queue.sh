#!/bin/sh
#
# Cancel and re-run a workflow run whose job has been stuck `queued` for too
# long, with no runner ever picking it up (#2081).
#
# ## The distinct failure mode this covers
#
# scripts/rerun-on-runner-loss.sh (#1997) re-runs a run once it reaches
# `completed` with `conclusion == 'failure'`, by reading the annotation the
# Actions service writes on a job whose runner died mid-run. A job that never
# STARTS -- stuck `queued` because the self-hosted runner pool has no capacity
# to pick it up -- never reaches `completed` at all, so that trigger never
# fires for it. On tabsii-com/tabsii-platform#1435, the `Terraform Validate &
# Security` job sat `queued` for ~31 minutes; `gh run rerun --failed` refused
# with "This workflow is already running" (there was nothing to re-run yet),
# and nothing alerted. An agent noticed by hand, ran `gh run cancel`, then
# re-ran the (now-cancelled) run.
#
# This script is that noticing, automated: a scheduled poll (see the sibling
# workflow file) over currently-active runs of the same watched workflows,
# looking for a job that has sat `queued` past a threshold, then doing exactly
# what the manual workaround did -- cancel the run, wait for the cancellation
# to actually land, then re-run it once.
#
# ## Why this scopes to the SAME named workflows as rerun-on-runner-loss.sh,
# ## and does NOT try to detect self-hosted vs GitHub-hosted per job
#
# The issue asks for detection "on self-hosted-runner workflows" specifically
# -- a GitHub-hosted runner essentially never queues for 20+ minutes, so
# scoping matters for avoiding false alarms during a rare GitHub-side
# incident, which is a human's call to re-run, not a bot's.
#
# The Jobs API's per-job `labels` field looked like the direct way to test
# that (does this job's `runs-on` resolve to something other than a
# known-hosted label?), but that field is populated from the RUNNER that
# picks the job up -- for a job that is still `queued` with no runner
# assigned yet, it is frequently empty. Gating detection on it risks a
# silent, permanent false negative: if `labels` is reliably empty for a
# genuinely stuck queued job, this script would never flag anything and
# would look like coverage while doing nothing (the exact class #1363
# describes -- a gate reporting green over a denominator it never printed).
# That was not verifiable against a real queued job from here (no live
# Actions run to inspect), so rather than ship an unverified per-job
# heuristic, this reuses the WORKFLOW-NAME scope rerun-on-runner-loss.sh
# already established and already tests true: 'CI', 'RLS Tests' and
# 'Release Guards' are the lanes that actually run on
# `${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}`, i.e. self-hosted in any
# instance that has set RUNNER_LABEL, and plain `ubuntu-latest` (so
# effectively inert for this script) everywhere else, including this
# template's own CI. `workflow_run.name` is always present on every run,
# unlike a queued job's `labels`, so this scope is provable rather than
# merely hoped for.
#
# Deploy workflows are excluded for the same reason rerun-on-runner-loss.sh
# excludes them: a `gh run rerun` (not `--failed` -- see below) re-runs every
# job in the run, including ones that already completed, and a deploy job
# re-run blind is not safe. A job that is still `queued` has, by definition,
# not started, so cancelling it destroys nothing on its own -- but the RUN it
# belongs to may contain other jobs that already applied something, so the
# same named-workflow allowlist is the safety boundary here too.
#
# ## What this deliberately does NOT cover
#
# A job stuck `in_progress` with an unresponsive runner (rather than never
# started) is a different shape again -- there is no heartbeat exposed by the
# API to judge "unresponsive" from, and if the runner is later reclaimed the
# job eventually fails with the annotation rerun-on-runner-loss.sh already
# reads. Building an additional, unverified heuristic for that here would be
# exactly the guessed-branch shape AGENTS.md warns against; it is left to a
# future, separately-evidenced change.
#
# ## POSIX sh; validate with BOTH `dash -n` and `bash -n`.
#
# Usage:  sh scripts/rerun-on-stuck-queue.sh [threshold-minutes]
# Needs:  GITHUB_REPOSITORY, and a `gh` authenticated with `actions: write`.
set -eu

REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
THRESHOLD_MINUTES="${1:-20}"

case "$THRESHOLD_MINUTES" in
  ''|*[!0-9]*)
    printf 'threshold must be a positive whole number of minutes, got %s\n' "$THRESHOLD_MINUTES" >&2
    exit 1
    ;;
esac
THRESHOLD_SECONDS=$((THRESHOLD_MINUTES * 60))

# Bounded poll for the cancellation to land (see the loop below). Overridable
# only so the self-test can exercise the "never confirms" path in well under
# a second instead of the real ~30s; production always gets the defaults.
POLL_ATTEMPTS="${RERUN_STUCK_QUEUE_POLL_ATTEMPTS:-6}"
POLL_INTERVAL="${RERUN_STUCK_QUEUE_POLL_INTERVAL:-5}"

# Same list, same reasoning as rerun-on-runner-loss.yml's `workflows:` --
# see the header above for why this is also the self-hosted-scoping boundary.
# Single-quoted so none of it needs shell escaping.
JQ_LIST_RUNS='.workflow_runs[] | select(.status != "completed") | select(.run_attempt == 1) | select(.name == "CI" or .name == "RLS Tests" or .name == "Release Guards") | [(.id|tostring), .name] | @tsv'
JQ_MAX_QUEUED_AGE='[.jobs[]? | select(.status == "queued") | (now - (.created_at | fromdateiso8601))] | max // empty'

# EXIT CODES, same convention as rerun-on-runner-loss.sh:
#   0  every candidate run was acted on or correctly left alone
#   1  could not tell, for at least one run (an API read failed, or a
#      requested cancellation never confirmed `completed` within the poll
#      window) -- LOUD on purpose, never folded into a silent pass
#   2  an action (cancel or re-run) was itself refused by the API, for at
#      least one run
EXIT_UNDETERMINED=1
EXIT_ACTION_FAILED=2

say() { printf '%s\n' "$*"; }

worst=0
note_worst() {
  [ "$1" -gt "$worst" ] && worst="$1"
  return 0
}

# --paginate: an instance running self-hosted CI at scale could plausibly
# have more than one page (100) of active runs across its watched
# workflows; without it, runs beyond page 1 would be silently invisible to
# this script rather than merely slow to reach, which is the same
# shrink-the-denominator failure the header discusses for per-job labels.
runs=$(gh api --paginate "repos/$REPO/actions/runs?per_page=100" --jq "$JQ_LIST_RUNS" 2>/dev/null) || {
  say "could not list active runs for $REPO — cannot tell whether any job is stuck, so nothing was inspected."
  exit "$EXIT_UNDETERMINED"
}

if [ -z "$runs" ]; then
  say "no active first-attempt run of a watched workflow (CI, RLS Tests, Release Guards) — nothing to inspect."
  exit 0
fi

# Written to a real file and read via `< "$RUNS_FILE"`, NOT piped into the
# while loop (`cmd | while read ...`). A pipeline's last stage runs in a
# subshell under bash by default (no `lastpipe`), so `worst`/the counters
# below would be invisible outside the loop and this script could exit 0
# after a real failure -- exactly the silent-pass shape AGENTS.md's §4.5
# asks every diff to be read for. Redirection from a file has no such
# subshell, under dash or bash.
RUNS_FILE=$(mktemp)
trap 'rm -f "$RUNS_FILE"' EXIT
printf '%s\n' "$runs" > "$RUNS_FILE"

inspected=0
stuck=0
acted=0

while IFS="$(printf '\t')" read -r run_id workflow_name; do
  [ -n "$run_id" ] || continue
  inspected=$((inspected + 1))

  jobs_json=$(gh api "repos/$REPO/actions/runs/$run_id/jobs?per_page=100" 2>/dev/null) || {
    say "could not list jobs for run $run_id ($workflow_name) — cannot tell whether it is stuck, leaving it alone."
    note_worst "$EXIT_UNDETERMINED"
    continue
  }

  # Age in seconds of the oldest still-`queued` job, or empty if none is
  # queued. `now` is jq's own invocation-time clock (UTC epoch seconds),
  # matched against the job's UTC `created_at` -- both from the same API
  # family, so no local clock is trusted here.
  oldest_queued=$(printf '%s' "$jobs_json" | jq -r "$JQ_MAX_QUEUED_AGE") || {
    say "could not evaluate queued-job age for run $run_id ($workflow_name) — leaving it alone."
    note_worst "$EXIT_UNDETERMINED"
    continue
  }

  if [ -z "$oldest_queued" ]; then
    continue
  fi
  # Integer-truncate for the comparison; jq's `now` is a float.
  oldest_queued_int=${oldest_queued%.*}
  if [ "$oldest_queued_int" -lt "$THRESHOLD_SECONDS" ]; then
    continue
  fi

  stuck=$((stuck + 1))
  say "run $run_id ($workflow_name) has a job queued for ${oldest_queued_int}s (>= ${THRESHOLD_SECONDS}s threshold) — cancelling and re-running once."

  if ! gh run cancel "$run_id" --repo "$REPO" >/dev/null 2>&1; then
    say "cancel of run $run_id was refused."
    note_worst "$EXIT_ACTION_FAILED"
    continue
  fi

  # Bounded poll for the cancellation to actually land: `gh run rerun` on a
  # run that has not yet reached `completed` fails with the same "already
  # running" refusal the manual workaround hit in the first place.
  # POLL_ATTEMPTS * POLL_INTERVAL (6 * 5s by default) gives GitHub's own
  # cancellation propagation a real window without an unbounded wait.
  confirmed=0
  attempt=0
  while [ "$attempt" -lt "$POLL_ATTEMPTS" ]; do
    status=$(gh api "repos/$REPO/actions/runs/$run_id" --jq '.status' 2>/dev/null) || status=""
    if [ "$status" = "completed" ]; then
      confirmed=1
      break
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -lt "$POLL_ATTEMPTS" ]; then
      sleep "$POLL_INTERVAL"
    fi
  done

  if [ "$confirmed" -ne 1 ]; then
    say "cancellation of run $run_id was accepted but never confirmed completed — leaving the re-run to the next scheduled poll."
    note_worst "$EXIT_UNDETERMINED"
    continue
  fi

  # A whole re-run, not `--failed`: the jobs in a cancelled run report
  # `conclusion == "cancelled"`, not `"failure"`, so `--failed` is not
  # guaranteed to pick the stuck job back up.
  if gh run rerun "$run_id" --repo "$REPO" >/dev/null 2>&1; then
    say "re-ran run $run_id once."
    acted=$((acted + 1))
  else
    say "re-run of run $run_id was refused."
    note_worst "$EXIT_ACTION_FAILED"
  fi
done < "$RUNS_FILE"

say "inspected $inspected candidate run(s), $stuck stuck, $acted re-run; exiting $worst."
exit "$worst"
