#!/usr/bin/env bash
#
# Is every integration branch in the estate actually protected?
#
# ## Why this exists (#715)
#
# `biffo init` catches a **403** from `updateBranchProtection` and skips, by
# design: GitHub refuses branch protection on a private org repo below a Team
# plan, retrying hits the identical 403, and failing a whole scaffold over a
# billing limitation would be worse. The comment reasoning that through is
# sound.
#
# **The defect is what happens next: nothing.** The warning is emitted once,
# into scaffold output nobody re-reads, and no later command re-checks —
# `biffo doctor`, `core upgrade` and `sibling create` all ignore it. The skip is
# permanent by default and silent from the second it scrolls past.
#
# The cost was measured and is a clean date boundary. `tabsii-com` was below
# Team until 2026-07-05, so everything scaffolded before it was unprotected and
# everything after was fine:
#
#     07-02  tabsii-platform   UNPROTECTED   <- the live core platform
#     07-03  tabsii-crm        UNPROTECTED
#     07-04  tabsii-intake     UNPROTECTED
#     07-05  tabsii-marketplace  protected
#
# Three repos ran with `dev`, `staging` and `main` all open for ~3 weeks, and
# **protection ended up inverted from the risk**: two front-ends were fully
# gated while the sole owner of all data (ADR-0002) allowed direct pushes,
# force-pushes, and merges with red or absent checks. Eight PRs merged into it
# in one session with no required-check gate — safe only because a human watched
# each one green, which is exactly the reliance AGENTS.md §5 forbids.
#
# They are protected today because somebody fixed them by hand. Nothing in the
# tooling did it and nothing would have said if they hadn't. This is the thing
# that says.
#
# Usage:
#   sh scripts/protection-audit.sh                     # repos under ~/code
#   sh scripts/protection-audit.sh --estate <dir>
#
# Exits non-zero if any integration branch is unprotected or has no required
# checks. Needs `gh` authenticated; without it, exits 2 rather than reporting
# health it cannot see.

set -uo pipefail

ESTATE="${1:-}"
[ "$ESTATE" = "--estate" ] && ESTATE="${2:-}"
[ -n "$ESTATE" ] || ESTATE="$HOME/code"

command -v gh >/dev/null 2>&1 || { echo "protection-audit: gh not installed" >&2; exit 2; }
gh auth status >/dev/null 2>&1 || {
  # Never report "all protected" from an unauthenticated run. An audit that
  # cannot see is not an audit that found nothing -- that conflation is the
  # fail-open shape this whole family of checks exists to remove.
  echo "protection-audit: gh is not authenticated, so protection cannot be read." >&2
  echo "  Refusing to report health that was not observed." >&2
  exit 2
}

bad=0
checked=0
seen_slugs=""
unprotected_list=""

printf '\nbranch protection - is every integration branch actually gated?\n\n'

for d in "$ESTATE"/*/; do
  d="${d%/}"
  [ -e "$d/.git" ] || continue
  slug=$(git -C "$d" remote get-url origin 2>/dev/null | sed -E 's#.*[:/]([^/]+/[^/]+)$#\1#; s#\.git$##')
  [ -n "$slug" ] || continue
  label=$(basename "$d")
  # Two local clones can share a remote (biffo-template and biffo-template-fresh),
  # and auditing a GitHub repo twice reports the same branch twice.
  case " $seen_slugs " in *" $slug "*) continue ;; esac
  seen_slugs="$seen_slugs $slug"

  # WHICH branches must be protected is derived from the repo's own shape, not a
  # list somebody maintains:
  #
  #   dev   the integration branch in every Biffo repo (AGENTS.md section 2).
  #         Required wherever it exists.
  #   main  PRODUCTION, and only in a DEPLOYABLE repo -- instances and sibling
  #         apps, identified by having a deploy workflow. In a non-deployable
  #         repo (runner fleets, a docs repo, a published package) `main` is just
  #         the default branch of something that never deploys, and demanding
  #         protection there buys nothing.
  #
  # This matters more than it looks. An audit that fails every single day on a
  # condition everyone has accepted is an audit people learn to scroll past --
  # and then it is worth nothing on the day it reports something real. Four
  # repos here have zero deploy workflows AND no `dev` branch; flagging them
  # daily forever would have trained exactly that reflex.
  deployable=no
  ls "$d/.github/workflows/" 2>/dev/null | grep -q "deploy" && deployable=yes

  for br in dev main; do
    git -C "$d" rev-parse --verify --quiet "origin/$br" >/dev/null 2>&1 || continue
    if [ "$br" = "main" ] && [ "$deployable" = "no" ]; then
      printf '  \033[90m--           %-38s %-6s not deployable, main not required\033[0m\n' "$slug" "$br"
      continue
    fi
    checked=$((checked + 1))
    # Capture the EXIT STATUS, and validate the value is a number before
    # believing it.
    #
    # The first version read only stdout and matched with `case`. On an
    # unprotected branch `gh` prints its 404 JSON *to stdout*, which fell through
    # to the wildcard and was reported `ok` -- so this audit passed three
    # genuinely unprotected branches and exited 0 on its very first run.
    #
    # An audit that fails open is worse than no audit, and writing one INTO a
    # check built to catch exactly that is the reason this comment is long. It
    # was caught by running it and reading every line, not by trusting the
    # summary.
    n=$(gh api "repos/$slug/branches/$br/protection" -q '.required_status_checks.contexts | length' 2>/dev/null)
    rc=$?
    case "$n" in
      ''|*[!0-9]* ) n="" ;;
    esac
    [ "$rc" -ne 0 ] && n=""
    case "${n:-none}" in
      none )
        bad=$((bad + 1))
        unprotected_list="$unprotected_list  $slug ($br) - no protection at all
"
        printf '  \033[31mUNPROTECTED\033[0m  %-38s %s\n' "$slug" "$br" ;;
      0 )
        # Protected, but requiring nothing -- a gate that gates nothing. Counted
        # as a failure deliberately: it reads as protected in the GitHub UI.
        bad=$((bad + 1))
        unprotected_list="$unprotected_list  $slug ($br) - protected but 0 required checks
"
        printf '  \033[31mNO CHECKS\033[0m    %-38s %s\n' "$slug" "$br" ;;
      * )
        printf '  \033[32mok\033[0m           %-38s %-6s %s required checks\n' "$slug" "$br" "$n" ;;
    esac
  done
done

printf '\n%s branches checked, ' "$checked"
if [ "$bad" -eq 0 ]; then
  printf '\033[32mall protected\033[0m\n\n'
  exit 0
fi
printf '\033[31m%s unprotected or ungated\033[0m\n\n%s\n' "$bad" "$unprotected_list"
printf 'AGENTS.md section 2 asserts "Branch protection stays on". Where this fails, that\n'
printf 'sentence is untrue and the only gate is whoever happens to be watching.\n\n'
exit 1
