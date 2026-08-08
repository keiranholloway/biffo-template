#!/usr/bin/env bash
#
# Wait for a pull request's checks to finish, without mistaking "not started"
# for "all green".
#
# ## Why this exists
#
# Every session hand-rolls this loop, and the natural formulation is wrong in
# the dangerous direction:
#
#   until [ "$(gh pr checks "$N" | grep -c pending)" = 0 ]; do sleep 30; done
#
# That polls for the **absence** of pending work, so a transient empty set reads
# as completion. Immediately after `gh pr update-branch` GitHub drops the
# superseded check runs before registering the new ones — for a few seconds
# there are **zero** checks, `pending` is 0, and the loop exits on a PR whose CI
# has not started. The caller then merges. Observed on 2026-08-02 while clearing
# a 13-repo queue; the same session also wrote an `until` whose `|| &&`
# precedence never terminated and burned a full 10-minute timeout.
#
# That is the estate's dominant failure shape — a gate passing because it cannot
# run — reproduced inside the agent's own tooling, where no CI guard can see it.
#
# ## The rule this encodes
#
# **Wait on a positive signal, never on the absence of a negative.** Two ways to
# get one, strongest first:
#
# 1. **Branch protection's required contexts.** If the base branch is protected,
#    those names are exactly the checks that MUST report, so "every required
#    context has concluded" is a direct answer rather than an inference. This is
#    the only condition that cannot be satisfied by an empty or half-registered
#    set.
# 2. **Stability, when protection is unreadable.** Some repos are unprotected
#    (both plugin repos were until 2026-07-27) and a token may lack the scope to
#    read protection. Then: at least one check present, all concluded, and the
#    same count seen on two consecutive polls — so a fast check concluding while
#    slower ones are still registering does not end the wait early.
#
# ## A re-run does not replace its old entry, and `statusCheckRollup` never drops it
#
# `statusCheckRollup` returns **every** check run against the PR's head commit,
# including ones a later run has superseded — a re-run adds a second row under
# the same name rather than replacing the first. Read naively, a check that
# failed once and was then fixed by a re-run still shows a FAILURE row forever,
# so "any row with a FAILURE conclusion" reports the wrong thing on exactly the
# PRs most likely to need this script: anything that failed and was corrected.
# GitHub's own merge gate, and `gh pr checks`, both resolve a required context to
# the **latest** run of that name — this script has to do the same, or it
# disagrees with the authority it exists to reflect (#1333, class #1362).
#
# So the rollup is deduped by name, keeping the entry with the latest
# `completedAt`/`startedAt` (falling back to `updatedAt`/`createdAt` for a plain
# commit status, which carries no `startedAt`/`completedAt` at all), **before**
# any conclusion is evaluated. Same `group_by | max_by(latest timestamp)` shape
# `branch-health.sh` already uses for its per-workflow rollup — that script reads
# `gh run list`, whose rows are one per distinct run rather than per check name,
# so it was never exposed to this defect, but the resolution method is the same
# one worth keeping consistent.
#
# ## Exit codes, and why 2 exists
#
#   0  every required/observed check concluded, none failed
#   1  a check failed — the names are printed
#   2  cannot determine: timed out, no checks ever appeared, PR unreadable
#
# 2 is distinct from 1 on purpose, and neither is 0. A timeout is not a pass,
# and a caller that treats "cannot tell" as "green" has rebuilt the defect this
# script exists to prevent. `ci-wiring-audit.sh` uses the same 2-means-cannot-run
# convention.
#
# `cancelled` is reported separately rather than as a failure: on this estate's
# self-hosted runners a cancelled job is usually spot reclamation or a
# `cancel-in-progress` concurrency group, not the code. It still exits 1 —
# something must be re-run — but the message says which, so nobody debugs a
# phantom.
#
# ## A conflicting PR has no checks, and never will
#
# GitHub cannot compute a merge commit for a branch that conflicts with its
# base, and it creates **no check runs at all** for such a PR — `gh pr checks`
# reports "no checks reported" and the rollup stays empty until the branch is
# rebased. From the checks alone that is indistinguishable from "CI has not
# started yet", so this script would wait out its entire timeout on a PR whose
# checks can never arrive. On 2026-08-03 PR #1243 spent over ten minutes
# printing "Waiting on 5 required check(s)" while one API field said why
# (#1246).
#
# So each poll also reads `mergeable`:
#
#   CONFLICTING  exit 2 immediately, naming the cause and the remedy. Still
#                "cannot tell", never a pass — the change is failing *fast*,
#                not failing open.
#   UNKNOWN      keep waiting. GitHub returns it transiently while it computes
#                mergeability, which it always does for a few seconds after a
#                push, so treating it as a conflict would be a fresh fail-fast
#                bug of exactly the shape this script exists to prevent.
#   anything     keep waiting on the checks as before. An unreadable field
#   else         (old gh, missing scope) must never become a verdict.
#
# ## Usage
#
#   sh scripts/wait-for-checks.sh <pr-number> [-R owner/repo]
#                                 [--timeout SECONDS] [--interval SECONDS]
#
# Requires `gh`, authenticated. Uses gh's embedded jq, so no jq binary is needed.

set -uo pipefail

PR=""
REPO=""
TIMEOUT="${WAIT_FOR_CHECKS_TIMEOUT:-1800}"
INTERVAL="${WAIT_FOR_CHECKS_INTERVAL:-30}"

usage() {
  # Print the whole header block, however long it grows: from line 2 up to the
  # first line that is not a comment. A hard-coded end line silently truncates
  # the help the moment anyone documents something new above it.
  sed -n '2,/^[^#]/p' "$0" | sed -n 's/^# \{0,1\}//p'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    -R | --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --timeout)
      TIMEOUT="${2:-}"
      shift 2
      ;;
    --interval)
      INTERVAL="${2:-}"
      shift 2
      ;;
    -h | --help) usage ;;
    *)
      PR="$1"
      shift
      ;;
  esac
done

[ -n "$PR" ] || {
  echo "wait-for-checks: no PR number given" >&2
  usage
}

RED=$(printf '\033[31m')
GREEN=$(printf '\033[32m')
DIM=$(printf '\033[90m')
OFF=$(printf '\033[0m')

gh_pr() {
  if [ -n "$REPO" ]; then gh pr "$@" --repo "$REPO"; else gh pr "$@"; fi
}

gh_api() {
  gh api "$@" 2>/dev/null
}

# --- What is this PR, and is there anything to wait for? ----------------------

meta=$(gh_pr view "$PR" --json state,baseRefName --jq '"\(.state)\t\(.baseRefName)"') || {
  echo "${RED}wait-for-checks: cannot read PR $PR${OFF}" >&2
  exit 2
}
state=${meta%%	*}
base=${meta##*	}

case "$state" in
  MERGED | CLOSED)
    echo "${DIM}PR $PR is $state — nothing to wait for.${OFF}"
    exit 0
    ;;
esac

# --- Signal 1: the checks branch protection says MUST report ------------------

owner_repo="$REPO"
[ -n "$owner_repo" ] || owner_repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)

required=""
if [ -n "$owner_repo" ]; then
  required=$(gh_api "repos/$owner_repo/branches/$base/protection" \
    --jq '.required_status_checks.contexts[]?' | sort -u)
fi

if [ -n "$required" ]; then
  echo "${DIM}Waiting on $(echo "$required" | wc -l | tr -d ' ') required check(s) on $base.${OFF}"
else
  # Not an error. An unprotected branch is a real configuration, and a token
  # without the scope to read protection is common. Say which mode is in use, so
  # a weaker guarantee is never mistaken for the strong one.
  echo "${DIM}No readable branch protection on $base — falling back to stability.${OFF}"
fi

# --- Poll ---------------------------------------------------------------------

deadline=$(($(date +%s) + TIMEOUT))
prev_count=-1
rollup=""

while :; do
  # Read this every poll, not once up front: a PR is frequently UNKNOWN for the
  # first few seconds after a push and only then resolves, and a PR that starts
  # clean can be made CONFLICTING at any moment by a merge into the base branch.
  mergeable=$(gh_pr view "$PR" --json mergeable --jq '.mergeable' 2>/dev/null) || mergeable=""

  if [ "$mergeable" = "CONFLICTING" ]; then
    echo "${RED}wait-for-checks: PR $PR conflicts with $base.${OFF}" >&2
    echo "GitHub creates no check runs for a PR whose merge commit it cannot" >&2
    echo "compute, so the checks this is waiting for will never appear. Rebase" >&2
    echo "the branch on $base (or merge $base into it) and push — CI starts as" >&2
    echo "soon as the conflict clears." >&2
    echo "Not a failure and not a pass: this is 'cannot tell'." >&2
    exit 2
  fi

  rollup=$(gh_pr view "$PR" --json statusCheckRollup --jq '
    [ .statusCheckRollup[]?
      | { name:  (.name // .context),
          state: (.conclusion // .state // (if .status == "COMPLETED" then "" else null end)),
          when:  (.completedAt // .startedAt // .updatedAt // .createdAt // "")
        }
    ]
    | group_by(.name)
    | map(max_by(.when))
    | .[]
    | "\(.name)\t\(.state // "")"') || rollup=""

  count=0
  [ -n "$rollup" ] && count=$(printf '%s\n' "$rollup" | grep -c .)

  # Every check that has reported a terminal state.
  concluded=$(printf '%s\n' "$rollup" | awk -F'\t' 'NF && $2 != "" && $2 != "PENDING" && $2 != "IN_PROGRESS" && $2 != "QUEUED" && $2 != "WAITING" { print $1 }')

  done_waiting=0

  if [ -n "$required" ]; then
    # Strong condition: every required context is present AND concluded.
    missing=""
    while IFS= read -r ctx; do
      [ -n "$ctx" ] || continue
      printf '%s\n' "$concluded" | grep -Fxq "$ctx" || missing="$missing $ctx"
    done <<EOF
$required
EOF
    [ -z "$missing" ] && done_waiting=1
  else
    # Fallback: at least one check, all concluded, and the set has stopped
    # growing. The count check is what stops a fast Secret Scan concluding alone
    # while five slower jobs are still being registered.
    if [ "$count" -gt 0 ]; then
      n_concluded=$(printf '%s\n' "$concluded" | grep -c .)
      if [ "$n_concluded" = "$count" ] && [ "$count" = "$prev_count" ]; then
        done_waiting=1
      fi
    fi
  fi

  [ "$done_waiting" = "1" ] && break

  prev_count=$count

  now=$(date +%s)
  if [ "$now" -ge "$deadline" ]; then
    echo "${RED}wait-for-checks: timed out after ${TIMEOUT}s.${OFF}" >&2
    if [ "$count" = "0" ]; then
      # The exact case the naive loop gets wrong, so name it explicitly.
      echo "No checks ever appeared on PR $PR. That is 'cannot tell', not 'green'." >&2
      if [ "$mergeable" = "UNKNOWN" ]; then
        echo "GitHub never resolved this PR's mergeability (mergeable=UNKNOWN), which" >&2
        echo "is often how a conflict looks before it settles. Check it by hand." >&2
      fi
    else
      echo "Still unfinished:" >&2
      printf '%s\n' "$rollup" | awk -F'\t' 'NF && ($2 == "" || $2 == "PENDING" || $2 == "IN_PROGRESS" || $2 == "QUEUED" || $2 == "WAITING") { print "  " $1 }' >&2
    fi
    exit 2
  fi

  sleep "$INTERVAL"
done

# --- Report -------------------------------------------------------------------

failed=$(printf '%s\n' "$rollup" | awk -F'\t' 'NF && ($2 == "FAILURE" || $2 == "TIMED_OUT" || $2 == "ACTION_REQUIRED" || $2 == "STARTUP_FAILURE" || $2 == "ERROR") { print "  " $1 " (" $2 ")" }')
cancelled=$(printf '%s\n' "$rollup" | awk -F'\t' 'NF && $2 == "CANCELLED" { print "  " $1 }')

if [ -n "$cancelled" ]; then
  echo "${RED}Cancelled:${OFF}"
  printf '%s\n' "$cancelled"
  echo "${DIM}A cancelled check is usually infrastructure (spot reclamation, or a" >&2
  echo "cancel-in-progress concurrency group), not your code. Re-run it rather" >&2
  echo "than debugging a phantom.${OFF}" >&2
fi

if [ -n "$failed" ]; then
  echo "${RED}Failed:${OFF}"
  printf '%s\n' "$failed"
  exit 1
fi

[ -n "$cancelled" ] && exit 1

echo "${GREEN}All checks concluded, none failed.${OFF}"
exit 0
