#!/usr/bin/env bash
#
# Is the integration branch actually healthy — including the deploy, and
# including who broke it?
#
# ## Why this exists
#
# On 2026-08-02 an instance's `dev` deploy went red at 10:43 and nobody noticed
# until 12:36. **1h53m, four further merges**, each of which also failed, and
# development was effectively blocked for 2h25m. Three separate things had to be
# true at once for that to happen, and this script answers all three (#1133).
#
# **1. The obvious command hides the deploy.** An instance runs five workflows on
# a merge to `dev` — `CI`, `CodeQL`, `Core Version Tag`, `Deploy Application`,
# `RLS Tests` — and the reflexive check is:
#
#     gh run list --branch dev --limit 3
#
# which returns three that are *not* the deploy. "dev CI green" was reported
# truthfully and repeatedly by an agent following AGENTS.md, while the deploy was
# red the whole time. A truncated list is not a status; it is a sample. This
# script enumerates **every** workflow that ran on the branch and reports the
# latest conclusion of each, so nothing can fall off the bottom.
#
# **2. A red post-merge deploy has no audience.** A failing PR check is noticed
# because someone is watching their PR. A failing *post-merge* deploy is watched
# by nobody: the author has moved on, and the next person only discovers it by
# merging into it. So this notifies, reusing the desktop-alert channel
# `practices-daily.sh` established (`_notify`) — same opt-OUT posture, because an
# opt-in alert is how that notification once spent months existing and never
# firing.
#
# **3. A poisoned branch blames the wrong person.** Once `dev` is broken every
# subsequent merge fails too, so four people each saw *their* change fail. The
# expensive part was not the breakage, it was four independent diagnoses of an
# innocent change. On failure this walks the run history back to the **first
# failing run** and names its commit, author and time — so the fifth person in
# starts at the real cause instead of their own diff.
#
# ## Exit codes
#
#   0  every workflow observed on the branch concluded, none failed
#   1  something failed — the workflow names and the first bad commit are printed
#   2  cannot determine: no runs found, or the repo/branch is unreadable
#
# 2 is deliberately not 0, matching `wait-for-checks.sh` and `ci-wiring-audit.sh`.
# A check that cannot see its input must say so rather than passing: this
# estate's most repeated defect is a zero that means "could not look", and
# `protection-audit.sh` was reporting `27 branches, all protected` while silently
# dropping the four repos least likely to be protected (#1145).
#
# `cancelled` is reported but does not fail the branch. On self-hosted runners it
# is usually spot reclamation or a `cancel-in-progress` concurrency group — two
# merges landing seconds apart cancel the first run by design. It is called out
# by name so nobody debugs a phantom.
#
# ## Usage
#
#   sh scripts/branch-health.sh [-R owner/repo] [--branch dev] [--quiet]
#
# Requires `gh`, authenticated. Uses gh's embedded jq, so no jq binary is needed.

set -uo pipefail

REPO=""
BRANCH=""
QUIET=""

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
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    -h | --help) usage ;;
    *)
      echo "branch-health: unexpected argument '$1'" >&2
      usage
      ;;
  esac
done

RED=$(printf '\033[31m')
GREEN=$(printf '\033[32m')
YELLOW=$(printf '\033[33m')
DIM=$(printf '\033[90m')
OFF=$(printf '\033[0m')

# A real tab, built the same way the colours above are, and used as `IFS="$TAB"`.
#
# AGENTS.md invokes these scripts as `sh scripts/...`, and /bin/sh is dash here.
# The bash spelling `IFS=$'\t'` is NOT a syntax error under dash — it is read as
# the four literal characters `$ ' \ t`, so the field split then happens on any
# of them. The first draft of this script did exactly that and reported a
# workflow called "Deploy Applica", having split "Deploy Application" at its
# 't'. It printed one row instead of four and still exited 0.
#
# Same reason the colours use `$(printf '\033[31m')` rather than `$'\e[31m'`.
TAB=$(printf '\t')

gh_run() {
  if [ -n "$REPO" ]; then gh run "$@" --repo "$REPO"; else gh run "$@"; fi
}

# The integration branch is `dev` in every Biffo repo (AGENTS.md §2). Resolved
# from the repo rather than hardcoded so this still works in the rare repo whose
# default has not been migrated — and so the failure is "cannot read repo"
# rather than a confident answer about a branch that does not exist.
if [ -z "$BRANCH" ]; then
  if [ -n "$REPO" ]; then
    BRANCH=$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null)
  else
    BRANCH=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null)
  fi
fi

if [ -z "$BRANCH" ]; then
  echo "${RED}branch-health: cannot determine the integration branch.${OFF}" >&2
  exit 2
fi

label=${REPO:-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")}

# --- Every workflow that ran on the branch, not the first three --------------
#
# 200 runs is deep enough to reach every workflow's latest run even when a busy
# one (CI) dominates the head of the list. `--json` on `gh run list` returns them
# newest-first, so the first row per workflow name IS its latest run.

# `group_by | max_by(.createdAt)` rather than "first occurrence in a newest-first
# list": the ordering is gh's to change, and a status tool that quietly reports
# an older run because an API changed its sort is the same class of defect as the
# truncated list this replaces. Ask for the newest explicitly.
summary=$(gh_run list --branch "$BRANCH" --limit 200 \
  --json workflowName,status,conclusion,headSha,createdAt,url \
  --jq 'group_by(.workflowName)
        | map(max_by(.createdAt))
        | .[]
        | [ (if .status == "completed" then (.conclusion // "unknown") else .status end),
            .workflowName, .headSha[0:8], .createdAt[0:16], .url ]
        | @tsv' 2>/dev/null)

if [ -z "$summary" ]; then
  echo "${RED}branch-health: no workflow runs readable on '$BRANCH' in $label.${OFF}" >&2
  echo "${DIM}  That is 'cannot tell', not 'healthy' — exiting 2.${OFF}" >&2
  exit 2
fi

failed=""
pending=""
cancelled=""
skipped=""
ok=""

while IFS="$TAB" read -r state name sha when url; do
  [ -n "$name" ] || continue
  case "$state" in
    success) ok="${ok}${name}\n" ;;
    failure | timed_out | startup_failure)
      failed="${failed}${state}\t${name}\t${sha}\t${when}\t${url}\n"
      ;;
    cancelled) cancelled="${cancelled}${name}\n" ;;
    skipped) skipped="${skipped}${name}\n" ;;
    *) pending="${pending}${state}\t${name}\n" ;;
  esac
done <<EOF
$summary
EOF

# --- Report -------------------------------------------------------------------

echo "${DIM}$label — branch '$BRANCH', latest run per workflow${OFF}"
echo

# `printf '%b'` FIRST, then sed. These lists are accumulated as strings holding
# literal `\n` two-character sequences (POSIX sh has no clean way to append a
# real newline to a variable), so piping them straight to sed hands it a single
# line and only the first entry gets its prefix — which read as a workflow with
# no status at all. Expand the escapes, then prefix each real line.
[ -n "$ok" ] && printf '%b' "$ok" | sed "s/^/  ${GREEN}ok${OFF}         /"
[ -n "$skipped" ] && printf '%b' "$skipped" | sed "s/^/  ${DIM}skipped${OFF}    /"
[ -n "$cancelled" ] && printf '%b' "$cancelled" | sed "s/^/  ${YELLOW}cancelled${OFF}  /"

if [ -n "$pending" ]; then
  printf '%b' "$pending" | awk -F'\t' -v d="$YELLOW" -v o="$OFF" 'NF{printf "  %srunning%s    %s (%s)\n", d, o, $2, $1}'
fi

if [ -z "$failed" ]; then
  if [ -n "$cancelled" ]; then
    echo
    echo "${DIM}A cancelled run is usually spot reclamation or a superseded concurrency${OFF}"
    echo "${DIM}group, not the code. Re-run it rather than debugging it.${OFF}"
  fi
  echo
  echo "${GREEN}Nothing on '$BRANCH' is failing.${OFF}"
  exit 0
fi

echo
printf '%b' "$failed" | awk -F'\t' -v r="$RED" -v o="$OFF" 'NF{printf "  %s%s%s  %s  at %s  %s\n", r, $1, o, $2, $3, $5}'

# --- Who actually broke it ----------------------------------------------------
#
# The whole point of #1133's third defect. Walk this workflow's runs on this
# branch backwards from the newest failure through consecutive failures, and
# report the OLDEST one in that unbroken streak. That run's commit is where the
# breakage started, which is very often not the person now reading this.

echo
printf '%b' "$failed" | while IFS="$TAB" read -r state name sha when url; do
  [ -n "$name" ] || continue

  # Sort newest-first ourselves, cut the list at the most recent SUCCESS, and
  # take the oldest failure still inside that streak. Anything before a green run
  # is a different, already-fixed breakage and must not be blamed for this one.
  first=$(gh_run list --branch "$BRANCH" --workflow "$name" --limit 60 \
    --json conclusion,headSha,createdAt,displayTitle,url \
    --jq 'sort_by(.createdAt) | reverse
          | (map(.conclusion == "success") | index(true)) as $green
          | .[0: (if $green == null then length else $green end)]
          | map(select(.conclusion == "failure"
                    or .conclusion == "timed_out"
                    or .conclusion == "startup_failure"))
          | last
          | select(. != null)
          | [ .headSha[0:8], .createdAt[0:16], (.displayTitle // "")[0:72], .url ]
          | @tsv' 2>/dev/null)

  if [ -n "$first" ]; then
    f_sha=$(printf '%s' "$first" | cut -f1)
    f_when=$(printf '%s' "$first" | cut -f2)
    f_title=$(printf '%s' "$first" | cut -f3)
    f_url=$(printf '%s' "$first" | cut -f4)
    echo "  ${RED}$name${OFF} has been failing since ${YELLOW}$f_sha${OFF} ($f_when)"
    echo "    $f_title"
    echo "    ${DIM}$f_url${OFF}"
    if [ "$f_sha" != "$sha" ]; then
      echo "    ${DIM}The newest failure is at $sha — but it is NOT where this started.${OFF}"
      echo "    ${DIM}Diagnose $f_sha, not your own merge.${OFF}"
    fi
  else
    echo "  ${RED}$name${OFF} is failing at $sha ${DIM}(could not establish when it started)${OFF}"
  fi
done

# --- Tell somebody ------------------------------------------------------------
#
# Copied in posture, deliberately, from practices-daily.sh's `_notify`: opt-OUT
# via an env var rather than opt-in, because an opt-in alert is one that never
# fires. Replaces its own previous card rather than stacking, so a branch red for
# three days is one notification and not three.

_notify() {
  [ -z "$QUIET" ] || return 0
  command -v notify-send >/dev/null 2>&1 || return 0
  [ -z "${BRANCH_HEALTH_NO_DESKTOP_ALERT:-}" ] || return 0

  if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
    _bus="/run/user/$(id -u)/bus"
    [ -S "$_bus" ] || return 0
    DBUS_SESSION_BUS_ADDRESS="unix:path=$_bus"
    export DBUS_SESSION_BUS_ADDRESS
  fi

  _slug=$(printf '%s' "$label-$BRANCH" | tr -c 'a-zA-Z0-9' '-')
  _idfile="${XDG_RUNTIME_DIR:-/tmp}/biffo-branch-health-${_slug}.id"
  _prev=""
  [ -f "$_idfile" ] && _prev=$(cat "$_idfile" 2>/dev/null)

  # Built as a plain variable rather than `${_prev:+--replace-id="$_prev"}`.
  # That form nests double quotes inside a parameter expansion, which dash
  # refuses to parse — and because the script is run as `sh`, the failure lands
  # at RUNTIME, after all the useful output has already printed, turning a
  # correct exit 1 into a confusing exit 2.
  _replace=""
  [ -n "$_prev" ] && _replace="--replace-id=$_prev"

  _names=$(printf '%b' "$failed" | awk -F'\t' 'NF{printf "%s ", $2}')
  # Deliberately unquoted: empty must expand to no argument at all.
  # shellcheck disable=SC2086
  _new=$(notify-send --print-id $_replace \
    -u critical -a "biffo" \
    "$label: $BRANCH is red" \
    "$_names— nobody is watching a post-merge failure. sh scripts/branch-health.sh" 2>/dev/null)
  [ -n "$_new" ] && printf '%s' "$_new" > "$_idfile" 2>/dev/null
  return 0
}

_notify

echo
echo "${RED}'$BRANCH' is red. It blocks everyone — fixing it is the next task (AGENTS.md §6).${OFF}"
exit 1
