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
  sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'
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
  rollup=$(gh_pr view "$PR" --json statusCheckRollup --jq '
    [ .statusCheckRollup[]?
      | { name:  (.name // .context),
          state: (.conclusion // .state // (if .status == "COMPLETED" then "" else null end))
        }
    ] | .[] | "\(.name)\t\(.state // "")"') || rollup=""

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
