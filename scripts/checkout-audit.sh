#!/usr/bin/env bash
#
# Is each repo's PRIMARY checkout safe to read? (#1196)
#
# ## Why this exists
#
# `AGENTS.md` §1 warns that a stale primary checkout "once produced a whole
# audit against dead code (it 'found' a feature missing that had shipped weeks
# earlier)", and §2 says never leave one dirty or behind. Nothing checked either,
# and on 2026-08-03 it happened again — twice.
#
# An agent was asked to migrate `tabsii-crm`'s `auth.ts`. It reported a STOP
# condition: the file exported `signIn`/`signOut`/`userPool` and it declined to
# overwrite them. Every part of that analysis was internally consistent, well
# evidenced, and **wrong about the repo**:
#
#   origin/dev            36 lines, exports only getCurrentSession
#   the tree it read      80 lines, exports five more
#
# `~/code/tabsii-crm` was 16 commits behind `origin/dev`, 1 ahead, with 5 files
# of staged changes. The reasoning was sound; the INPUT was wrong. The cost was
# a wasted agent run and a recommendation that would have produced an
# unnecessary PR. `~/code/tabsii-marketplace` was found in the same state hours
# later.
#
# ## Why prose was not enough, and why this is not `verify.sh --checkout-health`
#
# It is documented in two places in `AGENTS.md` and it still happened, to an
# agent that had `AGENTS.md` in context. #1201 then added
# `sh scripts/verify.sh --checkout-health`, which answers the question well —
# and `verify.sh` says in its own comments that the push-time WARN "does not,
# and cannot, cover the read-only case the issue was filed for". Nothing invoked
# the standalone command, so it only ever fired if you already suspected the
# problem. The whole point is that nobody suspected it.
#
# So this is the estate-wide half: it runs unprompted, every morning, from the
# daily audit set.
#
# ## Why it re-implements the check rather than shelling into each repo
#
# Deliberate. Calling `sh scripts/verify.sh --checkout-health` in each satellite
# would depend on that repo having a CURRENT `verify.sh` — and a repo whose
# copy predates #1201 does not know the flag, so it would silently run the
# ENTIRE gate instead: minutes per repo, and a completely different question
# answered. The audits already walk the estate from the template for exactly
# this reason (`protection-audit.sh`, `hook-audit.sh`), and the check itself is
# a handful of plumbing commands.
#
# ## It reports; it NEVER cleans
#
# The staged work in a dirty checkout belongs to somebody. `git stash` is shared
# across worktrees, and `git reset --soft origin/<branch>` onto a moved ref
# silently reverts other people's merged work. Destroying uncommitted work to
# satisfy an audit would be a worse defect than the one being fixed.
#
# Usage:
#   sh scripts/checkout-audit.sh --estate ~/code
#
# Exits 1 if any primary checkout is unsafe to read, 0 otherwise.

set -uo pipefail

ESTATE=""
BRANCH="${BIFFO_INTEGRATION_BRANCH:-dev}"
# Two severities, and the split is the whole design.
#
# FAIL is reserved for states that need a HUMAN and do not self-heal: parked on
# the wrong branch, uncommitted files, unpushed commits. Someone has to decide
# what happens to that work.
#
# Being merely BEHIND is reported and does NOT fail. It self-heals with one
# `git pull`, and it goes wide every time the estate takes a distribution — the
# first run of this audit showed 13 of 15 repos behind, almost entirely because
# a shared-sync round had just merged 14 PRs. Failing on that would put the
# dashboard red every morning after ordinary work, which is precisely the
# argument `protection-audit.sh` makes at length against guards nobody reads.
#
# The distinction is not cosmetic: the incident this audit exists for
# (`tabsii-crm`, #1196) was 16 behind AND 1 ahead AND 5 files dirty. The dirty
# tree is why nobody could safely fix it from outside; the staleness alone
# would have been one command.
BEHIND_NOTE_LIMIT="${BIFFO_CHECKOUT_BEHIND_LIMIT:-5}"

while [ $# -gt 0 ]; do
  case "$1" in
    --estate) ESTATE="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$ESTATE" ] || { echo "--estate <dir> is required" >&2; exit 2; }

RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[90m'; OFF=$'\033[0m'

total=0; ok=0; unsafe=0; skipped=0; behind_only=0
report=""

for d in "$ESTATE"/*/; do
  d="${d%/}"
  [ -e "$d/.git" ] || continue
  # A linked worktree's `.git` is a FILE pointing into the primary's git dir.
  # Only the primary is in scope: a worktree being behind is what branching for
  # a unit of work looks like, and evaluating one would be noise.
  [ -d "$d/.git" ] || continue
  name=$(basename "$d")
  total=$((total + 1))

  head_branch=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$head_branch" = "HEAD" ]; then
    skipped=$((skipped + 1))
    report="${report}  ${DIM}n/a   ${name} — detached HEAD, not evaluated${OFF}\n"
    continue
  fi

  # Read-only and quiet. Without it, `origin/<branch>` is itself stale and a
  # genuinely-behind checkout reports current — the failure mode this audit is
  # for, one level up.
  git -C "$d" fetch origin --quiet 2>/dev/null

  if ! git -C "$d" rev-parse --verify --quiet "origin/$BRANCH" >/dev/null 2>&1; then
    skipped=$((skipped + 1))
    report="${report}  ${DIM}n/a   ${name} — no origin/${BRANCH}${OFF}\n"
    continue
  fi

  problems=""
  notes=""
  # §2: the primary must not be parked on a feature branch. Reported rather
  # than measured against origin/<branch>, because "behind" is meaningless when
  # the checkout is somewhere else entirely.
  if [ "$head_branch" != "$BRANCH" ]; then
    problems="parked on '${head_branch}'"
  else
    behind=$(git -C "$d" rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo 0)
    ahead=$(git -C "$d" rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo 0)
    [ "$behind" -gt "$BEHIND_NOTE_LIMIT" ] && notes="${behind} behind"
    # Unpushed work on the primary is a §1 violation and a loss risk, even when
    # it turns out to be a superseded duplicate — which is what both live
    # instances were. Worth surfacing either way; nothing said so.
    [ "$ahead" -gt 0 ] && problems="${ahead} ahead (unpushed)"
  fi

  dirty=$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  [ "$dirty" -gt 0 ] && problems="${problems:+$problems, }${dirty} uncommitted file(s)"

  if [ -n "$problems" ]; then
    unsafe=$((unsafe + 1))
    report="${report}  ${RED}UNSAFE${OFF} ${name} — ${problems}${notes:+, $notes}\n"
  elif [ -n "$notes" ]; then
    behind_only=$((behind_only + 1))
    report="${report}  ${DIM}behind${OFF} ${name} — ${notes}, otherwise clean${OFF}\n"
  else
    ok=$((ok + 1))
  fi
done

printf '\n%s primary checkouts — %b%s clean%b, %b%s unsafe to read%b, %s behind only, %s not evaluated\n' \
  "$total" "$GREEN" "$ok" "$OFF" "$RED" "$unsafe" "$OFF" "$behind_only" "$skipped"

if [ -n "$report" ]; then
  printf '\n'
  printf '%b' "$report"
fi

if [ "$unsafe" -gt 0 ]; then
  printf '\n%bReading one of these gives answers about code that is not on the integration branch.%b\n' "$DIM" "$OFF"
  printf '%bFix by hand — this audit deliberately never touches a working tree, because the%b\n' "$DIM" "$OFF"
  printf '%buncommitted work in one is somebody'"'"'s.%b\n\n' "$DIM" "$OFF"
  exit 1
fi

printf '\n'
exit 0
