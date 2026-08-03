#!/usr/bin/env sh
#
# Is anyone already working this issue? Ask git, not a label.
#
# ## Why this exists
#
# Several agent sessions run against this estate at once, and on 2026-08-03
# **four** of them collided in one morning:
#
#   - #1165 — another session built AND MERGED a PR for it while this one was
#     claiming it. Three minutes, start to merge.
#   - #1174 — a live worktree on `fix/1174-…` existed; the issue was unlabelled.
#   - #621, #956 — live worktrees, no labels. Labelled on their behalf.
#   - #1188 — the reverse: a label with no work, while another session built it
#     and opened a PR.
#
# Three of the four were "work exists, label does not". That is the shape this
# script is for.
#
# ## The rule it encodes
#
# **The `in-progress` label is a hand-maintained second copy of something git
# already knows.** A branch exists. A PR exists. Those are automatic — you
# cannot do the work without creating them — whereas the label is a separate
# action a human or agent has to remember, in a workflow that may never have
# been told to. Second copies of a decision drift; this estate says so about
# `_extract_detail`, about AGENTS.md, and about the commit-msg type list.
#
# So this checks FOUR signals and reports all of them, rather than trusting the
# one that is easiest to forget.
#
# ## What it cannot do
#
# Prevent a race. GitHub has no locking, two sessions can start in the same
# second, and #1165 went from branch to merged in three minutes — no protocol
# would have caught that. The goal is early, cheap detection, not exclusion.
# Every collision that morning was caught before duplicate work merged; the
# cost was minutes, not shipped rework.
#
# ## Usage
#
#   sh scripts/claim.sh 1234                 # check, and claim if free
#   sh scripts/claim.sh 1234 --check         # report only, change nothing
#   sh scripts/claim.sh 1234 -R owner/repo
#
#   0  free — and claimed, unless --check
#   1  taken, or already closed — the reason is printed
#   2  cannot tell — issue unreadable, gh unauthenticated
#
# 2 is deliberately not 0, matching `wait-for-checks.sh` and `branch-health.sh`.
# A check that cannot see its input must not report "free".
#
# Requires `gh`, authenticated. Uses gh's embedded jq, so no jq binary needed.

set -u

ISSUE=""
REPO=""
CHECK_ONLY=""

usage() {
  sed -n '2,58p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    -R | --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --check) CHECK_ONLY=1; shift ;;
    -h | --help) usage ;;
    *)
      ISSUE="$1"
      shift
      ;;
  esac
done

case "$ISSUE" in
  '' | *[!0-9]*)
    echo "claim: give an issue number, e.g. sh scripts/claim.sh 1234" >&2
    exit 2
    ;;
esac

RED=$(printf '\033[31m')
GREEN=$(printf '\033[32m')
YELLOW=$(printf '\033[33m')
DIM=$(printf '\033[90m')
OFF=$(printf '\033[0m')

gh_issue() { if [ -n "$REPO" ]; then gh issue "$@" --repo "$REPO"; else gh issue "$@"; fi; }
gh_pr() { if [ -n "$REPO" ]; then gh pr "$@" --repo "$REPO"; else gh pr "$@"; fi; }

LABEL=in-progress
TAKEN=0
REASONS=""

note() { REASONS="${REASONS}  $1\n"; TAKEN=1; }

# --- 0. Does the issue exist, and is it still open? --------------------------

meta=$(gh_issue view "$ISSUE" --json state,title,labels \
  --jq '"\(.state)\t\(.title)\t\((.labels|map(.name)|join(",")))"' 2>/dev/null) || {
  echo "${RED}claim: cannot read issue #$ISSUE${OFF} — wrong repo, or gh not authenticated." >&2
  echo "${DIM}  That is 'cannot tell', not 'free'.${OFF}" >&2
  exit 2
}

state=$(printf '%s' "$meta" | cut -f1)
title=$(printf '%s' "$meta" | cut -f2)
labels=$(printf '%s' "$meta" | cut -f3)

echo "${DIM}#$ISSUE — $title${OFF}"
echo

if [ "$state" != "OPEN" ]; then
  echo "${RED}Already $state.${OFF} Nothing to claim."
  exit 1
fi

# --- 1. The label. Easiest to check, easiest to forget. ----------------------

case ",$labels," in
  *",$LABEL,"*)
    updated=$(gh_issue view "$ISSUE" --json updatedAt --jq .updatedAt 2>/dev/null)
    note "${YELLOW}label${OFF}      carries '$LABEL' (issue last updated $updated)"
    ;;
esac

# --- 2. An open PR that references it ----------------------------------------
#
# The strongest signal, because a PR cannot be opened without the work existing.
# Matches the issue number in the title or body as a whole number, so #118 does
# not match #1188.

open_prs=$(gh_pr list --state open --limit 100 --json number,title,body,headRefName \
  --jq "[.[] | select(((.title + \" \" + .body) | test(\"(^|[^0-9])#$ISSUE([^0-9]|\$)\")) or (.headRefName | test(\"(^|[^0-9])$ISSUE([^0-9]|\$)\")))] | .[] | \"#\(.number) \(.headRefName)\"" 2>/dev/null)

if [ -n "$open_prs" ]; then
  printf '%s\n' "$open_prs" | while IFS= read -r pr; do
    [ -n "$pr" ] && echo "  ${RED}open PR${OFF}    $pr"
  done
  note "${RED}open PR${OFF}    see above — someone has working code"
fi

# --- 3. A remote branch naming it --------------------------------------------
#
# Catches work that has been pushed but has no PR yet. Whole-number match again.

branches=$(git ls-remote --heads "${REPO:+https://github.com/$REPO.git}" 2>/dev/null |
  sed 's|.*refs/heads/||' |
  grep -E "(^|[^0-9])$ISSUE([^0-9]|$)" 2>/dev/null)

if [ -n "$branches" ]; then
  printf '%s\n' "$branches" | while IFS= read -r b; do
    [ -n "$b" ] && echo "  ${RED}branch${OFF}     $b"
  done
  note "${RED}branch${OFF}     a remote branch names this issue"
fi

# --- 4. A recently merged PR that already closed it --------------------------
#
# Not "taken" — "possibly already done". #1165 was built and merged in three
# minutes; the only trace afterwards is a merged PR.

merged=$(gh_pr list --state merged --limit 30 --json number,title,body,mergedAt \
  --jq "[.[] | select((.title + \" \" + .body) | test(\"(^|[^0-9])#$ISSUE([^0-9]|\$)\"))] | .[0] | select(. != null) | \"#\(.number) merged \(.mergedAt[0:16])\"" 2>/dev/null)

if [ -n "$merged" ]; then
  echo "  ${YELLOW}merged${OFF}     $merged"
  echo "  ${DIM}           the issue is still open, but work referencing it has landed —${OFF}"
  echo "  ${DIM}           read it before rebuilding.${OFF}"
fi

# --- Verdict ------------------------------------------------------------------

echo
if [ "$TAKEN" -eq 1 ]; then
  printf '%b' "${RED}Taken.${OFF} Signals:\n$REASONS"
  echo
  echo "${DIM}If you believe it is abandoned, check how old the work is and say so in a${OFF}"
  echo "${DIM}comment before taking it. Never steal a fresh claim.${OFF}"
  exit 1
fi

if [ -n "$CHECK_ONLY" ]; then
  echo "${GREEN}Free.${OFF} ${DIM}(--check: nothing changed)${OFF}"
  exit 0
fi

# Claim it. Label AND comment together: the label is what other sessions filter
# on, the comment is what dates it so a stale claim can be recognised later.
gh_issue edit "$ISSUE" --add-label "$LABEL" >/dev/null 2>&1 || {
  echo "${RED}claim: could not apply the '$LABEL' label.${OFF}" >&2
  echo "${DIM}  Not claimed. Do not start work on the assumption that it worked.${OFF}" >&2
  exit 2
}
gh_issue comment "$ISSUE" \
  --body "Claimed at $(date -u +%FT%TZ) by \`$(git config user.name 2>/dev/null || echo agent)\`. Release it — remove the label — on merge, or if you stop." \
  >/dev/null 2>&1

echo "${GREEN}Claimed.${OFF}"
echo "${DIM}Push your branch as soon as it exists: a claim is a reservation, the branch${OFF}"
echo "${DIM}is the evidence, and the window between them is where collisions happen.${OFF}"
exit 0
