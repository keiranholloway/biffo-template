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
# ## Protection that binds nobody
#
# The audit above answers "is there protection". It does NOT answer "does the
# protection bind anyone", and for ~3 weeks those were different facts on 11 of
# 12 repos: `enforce_admins: false` makes every rule advisory for a repo admin,
# and the only human who merges here is an admin everywhere. A repo can show a
# full required-check list, report `ok` on this very line, and still be one where
# any of it can be walked past without a trace.
#
# This is not drift. It is written that way, twice, on purpose:
#
#   - `configureBranchProtection` (cli/src/adapters/source-control/github/index.ts)
#     sets it at scaffold time so a RESUMED `biffo init` can still commit to an
#     already-protected branch. That reason is real and it is scaffold-shaped --
#     it expires the moment init finishes, and nothing ever closes it again.
#   - `protectionParamsFor` (cli/src/lib/branch-protection-apply.ts) hardcodes it
#     into the BACKFILL payload too, so the command that exists to close
#     protection gaps writes the bypass back in every time it runs.
#
# Meanwhile `modules/source-control/github/main.tf` sets `enforce_admins = true`.
# The Terraform module and the CLI disagree about the intended steady state, and
# nothing has ever reported the difference -- so the CLI's temporary, init-time
# value has been the estate's permanent one.
#
# It surfaced only because an unrelated metric disagreed with a setting:
# `staleMergeShare` counted merges that were not up to date on three repos
# carrying `strict: true`, which that gate makes impossible by construction.
# The explanation was that the gate binds nobody.
#
# So this reports it, and FAILS on it. Reporting it while exiting 0 would repeat
# the exact defect described below at the `n=` line -- an audit that prints a
# problem and returns success gets wired into a pipeline that ignores it.
#
# Expect this to be red until each repo is decided rather than defaulted. That
# is the point: nobody has yet chosen the bypass, they inherited it.
#
# Usage:
#   sh scripts/protection-audit.sh                     # repos under ~/code
#   sh scripts/protection-audit.sh --estate <dir>
#
# Exits non-zero if any integration branch is unprotected, has no required
# checks, or has protection that does not bind admins. Needs `gh`
# authenticated; without it, exits 2 rather than reporting health it cannot see.

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
unbound=0
checked=0
seen_slugs=""
unprotected_list=""
unbound_list=""

printf '\nbranch protection - is every integration branch actually gated?\n\n'

for d in "$ESTATE"/*/; do
  d="${d%/}"
  [ -e "$d/.git" ] || continue
  slug=$(git -C "$d" remote get-url origin 2>/dev/null | sed -E 's#.*[:/]([^/]+/[^/]+)$#\1#; s#\.git$##')
  [ -n "$slug" ] || continue
  label=$(basename "$d")
  # Two local directories can share a remote, and auditing a GitHub repo twice
  # reports the same branch twice.
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
    # Both facts come from ONE call: whether the branch requires checks, and
    # whether any of it binds an admin. Two calls would double a daily API cost
    # for no gain, and could straddle a change and report a branch that never
    # existed in that state.
    raw=$(gh api "repos/$slug/branches/$br/protection" \
      -q '"\(.required_status_checks.contexts | length) \(.enforce_admins.enabled)"' 2>/dev/null)
    rc=$?
    n=""
    admins=""
    if [ "$rc" -eq 0 ]; then
      n="${raw%% *}"
      admins="${raw##* }"
      case "$n" in
        ''|*[!0-9]* ) n="" ;;
      esac
      # Anything that is not literally `true`/`false` is UNKNOWN, not `false`.
      # A missing field, a null, or a jq error must never read as a definite
      # answer in either direction -- see the fail-open note above.
      case "$admins" in
        true|false ) ;;
        * ) admins="" ;;
      esac
    fi
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
        case "$admins" in
          true )
            printf '  \033[32mok\033[0m           %-38s %-6s %s required checks, binds admins\n' \
              "$slug" "$br" "$n" ;;
          false )
            unbound=$((unbound + 1))
            unbound_list="$unbound_list  $slug ($br) - $n required checks, none of which bind an admin
"
            printf '  \033[31mADVISORY\033[0m     %-38s %-6s %s required checks, \033[31mdoes NOT bind admins\033[0m\n' \
              "$slug" "$br" "$n" ;;
          * )
            unbound=$((unbound + 1))
            unbound_list="$unbound_list  $slug ($br) - could not read enforce_admins
"
            printf '  \033[31mUNKNOWN\033[0m      %-38s %-6s %s required checks, enforce_admins unreadable\n' \
              "$slug" "$br" "$n" ;;
        esac ;;
    esac
  done
done

# The summary line must keep saying "branches checked": scripts/practices-daily.sh
# greps for exactly that to pull this audit's one-line result onto the dashboard,
# and a summary it cannot match reports "no summary line" every morning.
printf '\n%s branches checked, ' "$checked"
if [ "$bad" -eq 0 ] && [ "$unbound" -eq 0 ]; then
  printf '\033[32mall protected and binding\033[0m\n\n'
  exit 0
fi
if [ "$bad" -gt 0 ]; then
  printf '\033[31m%s unprotected or ungated\033[0m' "$bad"
  [ "$unbound" -gt 0 ] && printf ', '
fi
[ "$unbound" -gt 0 ] && printf '\033[31m%s not binding admins\033[0m' "$unbound"
printf '\n\n'

[ "$bad" -gt 0 ] && printf '%s\n' "$unprotected_list"
if [ "$unbound" -gt 0 ]; then
  printf '%s\n' "$unbound_list"
  # Say what to DO, because the remedy is a decision and not a command. Both
  # writers of this value are named so the next person does not rediscover that
  # `--fix` puts it back.
  printf 'These branches have protection that does not bind a repo admin, so every rule\n'
  printf 'above is advisory for the only people who merge. Decide it per repo rather than\n'
  printf 'inheriting it:\n\n'
  printf '  gh api -X PUT repos/<slug>/branches/<br>/protection/enforce_admins   # bind\n'
  printf '  gh api -X DELETE repos/<slug>/branches/<br>/protection/enforce_admins # bypass, deliberately\n\n'
  printf 'Note that `biffo doctor --fix` re-applies the bypass: protectionParamsFor() in\n'
  printf 'cli/src/lib/branch-protection-apply.ts hardcodes enforce_admins: false, as does\n'
  printf 'configureBranchProtection() at scaffold time. modules/source-control/github\n'
  printf 'sets it true. Binding a repo by hand does not survive either of those.\n\n'
fi
if [ "$bad" -gt 0 ]; then
  printf 'AGENTS.md section 2 asserts "Branch protection stays on". Where this fails, that\n'
  printf 'sentence is untrue and the only gate is whoever happens to be watching.\n\n'
fi
exit 1
