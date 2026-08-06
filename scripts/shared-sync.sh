#!/usr/bin/env bash
#
# Distribute the template's shared files to the repos `biffo core upgrade`
# cannot reach, and make drift visible when it happens.
#
# ## Why this exists
#
# Instances carry `biffo.core.json` and a `core-manifest.json`, so the CLI
# three-way-merges template-owned paths into them. **Sibling apps and plugin
# repos are separate repositories with neither.** The documented channel to them
# was "vendor it into the skeleton, plus a one-time manual copy-in for existing
# ones", which is not a mechanism: the skeleton only helps repos created
# afterwards, and nothing ever prompts the copy-in.
#
# The cost, twice over:
#
#   - AGENTS.md drifted 68 lines behind in tabsii, missing the very workflow
#     guardrails the template had already written (#559).
#   - Eight repos ran a local gate two versions old. `tabsii-crm` checked ONE
#     thing in eight on a 700-line change and printed `verify passed` (#855).
#
# Both were found by a human noticing, months and hours late respectively. This
# turns that into a command that reports, and a `--check` that fails.
#
# ## What it is not
#
# A **one-way overwrite**, not a merge. `shared-files.json` may only list files
# every sibling and plugin should hold verbatim. Anything a repo is expected to
# customise does not belong in it — that is what the instance manifest's
# three-way merge is for, and this deliberately has no such subtlety.
#
# ## Rehearsal: why a distribution run is two phases
#
# Measured on 2026-07-29: **84 `chore(shared): sync template-shared files` PRs
# merged across 12 satellites in one day** — 7 rounds, where one would have done.
# That is 33.5% of the estate's entire merge volume for the day, and every one of
# those PRs is classified `toil` by the practices collector, which read 60.2%.
# Six of the seven rounds carried `scripts/verify.sh` **alone**: the gate was
# being iterated downstream, one estate-wide lap per defect found (root-only
# checks, `--no-cov` in a repo without pytest-cov, the pytest opt-in, `--list`
# disagreeing with the gate).
#
# The reason a lap cost 12 PRs rather than 1 is that this script used to be a
# single pass: for each repo in turn, stage -> push -> open a PR. A defect
# discovered while staging repo 7 left 6 PRs already open, so fixing it meant a
# whole new round rather than a correction.
#
# So: **rehearse every target before touching any of them.** Phase 1 stages the
# candidate files into each repo and runs that repo's own gate against them,
# locally, with no push and no PR. Phase 2 ships — and only if phase 1 was clean
# everywhere. All 14 satellite clones are already on disk under `--estate`, so
# proving the estate costs seconds; proving it through GitHub costs 12 PRs and 12
# CI runs per lap.
#
# **It is not enough to let the target repo's pre-push hook catch this**, which
# is what the push in phase 2 relies on. That hook is exactly the thing that was
# silently DEAD in every fresh worktree until #845, and `scripts/hook-audit.sh`
# exists because the failure was invisible. A repo whose hook is dead pushes
# happily and opens a PR carrying an unproven gate — the fail-open shape this
# whole file set exists to remove. Rehearsal runs the gate itself and reads its
# exit code, so it does not depend on the hook being armed.
#
# Usage:
#   sh scripts/shared-sync.sh --check --estate ~/code    # report drift, exit 1 if any
#   sh scripts/shared-sync.sh --rehearse --estate ~/code # prove the candidates, ship nothing
#   sh scripts/shared-sync.sh --estate ~/code            # rehearse, then open a PR per repo
#   sh scripts/shared-sync.sh --estate ~/code --repo tabsii-crm
#   sh scripts/shared-sync.sh --estate ~/code --no-rehearse  # ship unproven, loudly
#   sh scripts/shared-sync.sh --candidates --estate ~/code   # unlisted paths worth triaging (#1108)
#   sh scripts/shared-sync.sh --backfill --estate ~/code     # skeleton files older repos never got (#1109)
#   sh scripts/shared-sync.sh --skeleton-adoption --estate ~/code  # skeleton paths not held by EVERY applicable repo (#1271)
#
# ## `--skeleton-adoption`: enumerate, don't threshold (#1271)
#
# `--candidates` (below) is blind to exactly the case it would be most useful
# for. It requires a path in >=5 repos before it reports it, so a file the
# skeleton gained recently -- which few or no siblings have adopted yet -- is
# invisible, and the fewer repos that hold it the LESS visible it is. Signal
# runs backwards against need. Measured 2026-08-04: 15 of the 76 paths the
# sibling skeleton owns sat below that threshold, entirely unreported,
# including one at 0/7.
#
# This mode has no threshold to be blind below, because it does not sample --
# it enumerates. The skeleton's file list is already known (it is whatever
# `_skeletons/<name>/` contains), so instead of asking "what do many repos
# happen to hold?" it asks the direct question: "of the paths a skeleton
# actually owns, which ones does every applicable repo hold?" A path held by
# 0 repos is exactly as reportable as one held by 6 of 7 -- both are "not
# held by all" -- so unlike `--backfill` this does NOT skip the
# nobody-has-it case (that is scaffolding for `--backfill`'s purpose, but for
# adoption tracking a 0/7 is the loudest possible signal, not noise).
#
# "Repo skeleton" is discovered the same way
# `cli/src/lib/skeleton-governance-workflows.test.ts` discovers it: a
# directory under `_skeletons/` that ships `.github/workflows/ci.yml`. Not a
# hardcoded name list -- `_skeletons/registry/` is plugin-registry *content*
# (`plugins.json` and its schema), never scaffolded into a repo, and ships no
# CI workflow at all, so it is excluded by construction rather than by an
# exception someone has to remember to add.
#
# Advisory only, exactly like `--candidates` and `--backfill`: this is a
# question for a human to triage (declare the deliberate ones, backfill the
# rest, or add a channel for the ones with none), never a build failure. It
# always exits 0. A per-path baseline ratchet, so a NEW gap can fail CI while
# pre-existing residue does not, is the natural next step (`shared-files.json`
# would carry it, the way `mustBeUniform` baselines do) but is deliberately
# not built here -- that is a decision for whoever owns the ratchet, not a
# side effect of the report existing.
#
# ## `mustBeUniform` and `--candidates` (#1108)
#
# `files` / `filesIfPresent` / `filesFromSkeleton` all WRITE. `mustBeUniform` is
# the fourth list and the only one that does not: it asserts that a path should
# read identically across the repos that hold it, without ever overwriting any
# of them. `_extract_detail` was written twice, independently, in two different
# siblings, for the same defect -- because nothing said "this shape already
# exists elsewhere, go look". A one-way overwrite cannot be the answer for a
# path that has not been reconciled (see "Reconcile before you distribute" in
# AGENTS.md section 9 -- `auth.ts` alone diverges 29-247 lines across seven
# repos); `mustBeUniform` is how the debt gets TRACKED before it can be paid
# down. `--check` fails only when a path's variant count exceeds the baseline
# recorded for it in shared-files.json -- copying the posture
# `biffo.orphan-baseline.json` established for the orphan ratchet
# (cli/src/lib/core-upgrade.ts): pre-existing residue never hard-blocks, only a
# regression does. It always reads `origin/<base>`, never a working tree --
# measuring from a stale local clone once reported api-client.ts at 4 variants
# when the estate, from its remote refs, was actually at 1.
#
# `--candidates` is a SEPARATE, advisory-only mode: it walks every applicable
# repo's tree and reports unlisted paths held in 5+ repos, bucketed by variant
# count, so a human can triage them into `mustBeUniform` (divergent) or `files`
# / `filesIfPresent` (uniform). It never fails -- always exits 0 -- because it is
# a question for a human, not a gate.

set -u
# `pipefail` is not POSIX, and this file is documented and invoked as
# `sh scripts/shared-sync.sh` -- including by scripts/practices-daily.sh.
#
# It carried a bare `set -uo pipefail` for as long as it only ever ran on the
# workstation, whose /bin/sh is dash 0.5.12, a version that happens to accept
# `-o pipefail`. The first time anything executed it elsewhere -- a test, on a
# CI runner with an older sh -- it died at this line with
# `set: Illegal option -o pipefail`, before parsing a single argument. Nothing
# had noticed, because nothing had ever run it anywhere else.
#
# That is the third instance of this class in the corpus: the same one-version
# difference in the same shell made js-dependency-audit.sh mangle every advisory
# payload while exiting 0 (#883). Enable it where it exists, carry on where it
# does not.
(set -o pipefail) 2>/dev/null && set -o pipefail || true

TEMPLATE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---- worktree lifecycle log (#1160) -----------------------------------------
#
# On 2026-08-02 two repos in a 13-repo round reached phase 2 with their staged
# worktree gone. Three hypotheses have been written and discarded against it:
# a concurrent SHIP run (there was none -- the four overlapping runs that day
# were all `--check`, which never reaches `stage_repo`), an unchecked
# `worktree add` (checked since #856), and a missing base ref (the ship path
# takes its base from `gh repo view`). Nothing found so far can remove that
# directory.
#
# The failure is rare, non-deterministic and has resisted reproduction, so this
# stops guessing and makes the NEXT occurrence explain itself: every create and
# every remove, with a timestamp and the PID that did it. Two concurrent runs
# interleave in one file, so `run-start`/`run-end` bracketing is what shows a
# second process operating inside the first one's round -- the shape three
# hypotheses have been about.
#
# **Always on, deliberately.** An opt-in flag would be off when a rare
# non-deterministic failure happens, which is the only time it is worth having.
# The cost is a handful of short lines per run.
#
# Appended, never read by this script, and failure to write is ignored: this is
# a side channel, not a gate. That is NOT the `2>/dev/null` antipattern recorded
# for the fetch in #1158 -- there the suppressed error changed the meaning of
# everything after it, whereas a log that cannot be written changes nothing
# except that the next occurrence stays unexplained. Lines are short and appends
# are atomic under PIPE_BUF, so concurrent runs interleave cleanly rather than
# tearing.
SYNC_WT_LOG="${SHARED_SYNC_WT_LOG:-$HOME/.shared-sync-worktrees.log}"

wt_log() {
  # event, repo label, path
  printf '%s\tpid=%s\t%-20s\t%-26s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$1" "$2" "${3:-}" >> "$SYNC_WT_LOG" 2>/dev/null || true
}
MANIFEST="$TEMPLATE_ROOT/shared-files.json"
[ -f "$MANIFEST" ] || { echo "no shared-files.json beside $0" >&2; exit 2; }

CHECK=""
ESTATE=""
ONLY=""
REHEARSE_ONLY=""
NO_REHEARSE=""
CANDIDATES=""
BACKFILL=""
ADOPTION=""
SCHEDULED=""
NOW=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --rehearse) REHEARSE_ONLY=1; shift ;;
    # In the open, per AGENTS.md section 7: a gate that can be skipped silently
    # is not a gate. This prints the reason on every line it lets through, so a
    # transcript shows what was shipped unproven.
    --no-rehearse) NO_REHEARSE=1; shift ;;
    # Advisory discovery, not the guard (#1108) -- see the block comment above.
    --candidates) CANDIDATES=1; shift ;;
    # The other discovery direction (#1109) -- see its block comment below.
    --backfill) BACKFILL=1; shift ;;
    # Enumerate rather than threshold (#1271) -- see the block comment above.
    --skeleton-adoption) ADOPTION=1; shift ;;
    # The two halves of the round gate below. `--scheduled` marks the daily
    # round (scripts/shared-sync-daily.sh); `--now` is the human override for a
    # change that must not wait for it.
    --scheduled) SCHEDULED=1; shift ;;
    --now) NOW=1; shift ;;
    --estate) ESTATE="$2"; shift 2 ;;
    --repo) ONLY="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$ESTATE" ] || { echo "--estate <dir> is required" >&2; exit 2; }

# Bracket the run before any work: a second process operating inside another's
# round is only visible if both ends are recorded.
SYNC_RUN_MODE=ship
[ -n "$CHECK" ] && SYNC_RUN_MODE=check
[ -n "$REHEARSE_ONLY" ] && SYNC_RUN_MODE=rehearse
[ -n "$NO_REHEARSE" ] && SYNC_RUN_MODE=ship-unproven
[ -n "$CANDIDATES" ] && SYNC_RUN_MODE=candidates
[ -n "$BACKFILL" ] && SYNC_RUN_MODE=backfill
[ -n "$ADOPTION" ] && SYNC_RUN_MODE=skeleton-adoption
wt_log "run-start($SYNC_RUN_MODE)" "${ONLY:-<all repos>}" "$ESTATE"

# `trap ... EXIT` REPLACES any previous EXIT trap, and two more are set further
# down (the --candidates temp file, and TARGETS/VERDICTS). A bare trap here
# would therefore be silently dead in every run that reaches them -- which is
# most runs, and exactly the ones worth logging. So every EXIT trap in this file
# calls this, and adding another means calling it too.
wt_log_run_end() {
  wt_log "run-end($SYNC_RUN_MODE)" "${ONLY:-<all repos>}" "$ESTATE"
}
trap wt_log_run_end EXIT
[ -n "$REHEARSE_ONLY" ] && [ -n "$NO_REHEARSE" ] && {
  echo "--rehearse and --no-rehearse are opposites" >&2; exit 2; }

FILES=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).files.join('\n'))")
MARKERS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).appliesTo.join(' '))")

# `filesIfPresent`: files kept in step ONLY in the repos that already hold them,
# never created in the ones that do not. Emitted as `target<TAB>source`, because
# unlike `files` the template's copy does not live at the same path -- the
# canonical copy of a sibling's `apps/frontend/...` is in the SKELETON, since
# this repo has `apps/portal/` and no `apps/frontend/` at all.
#
# Why a second list rather than more entries in `files`:
#
#   - `files` CREATES what is absent (`mkdir -p` + `cp` in stage_repo, and
#     diff_files reports a missing copy as drift). That is right for a gate
#     every repo must run, and wrong for frontend source: it would write
#     `apps/frontend/src/lib/api-client.ts` into two plugin repos, two runner
#     repos and a design repo that have no frontend at all.
#   - Backfilling a file into a repo that never had one is a materially
#     different and riskier operation than keeping existing copies in step, and
#     it should be a decision somebody makes, not a side effect of adding a line
#     to a manifest. The mechanism CAN do it -- that is what `files` is -- so
#     this list exists to say when it must not.
CONDITIONAL=$(node -e "const m=JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).filesIfPresent||{};console.log(Object.entries(m).map(([t,s])=>t+'\t'+s).join('\n'))")

# `filesFromSkeleton`: the THIRD list (#1150). Files whose canonical copy lives in
# the SKELETON matching the receiving repo's flavour, emitted as `path=policy`
# lines. Paths and policies never contain whitespace, so this is iterated with
# plain word splitting exactly like $FILES.
#
# Why neither of the other two lists could do this job:
#
#   - `files` CREATES what is absent, which is precisely what backfilling eleven
#     bare repos needs -- but it is a plain list, same path both sides, and the
#     satellite ruleset is NOT this repo's root AGENTS.md. That one carries
#     section 9's template->instance distribution, core-manifest.json and the
#     upgrade flow; none of it applies to a satellite.
#   - `filesIfPresent` takes exactly the target->source remap that is needed, and
#     deliberately never creates. Creating is the whole job.
#
# And why this is a third list rather than teaching `files` the remap:
#
#   - THE SOURCE IS NOT ONE FILE. `_skeletons/plugin-template/AGENTS.md` differs
#     from the sibling one by 50 lines of birth-time branch-protection and
#     runner-grant checklist (#714, written because both plugin repos ran with no
#     branch protection at all). A single-source remap would delete that from the
#     plugin repos or force it into every sibling -- and
#     shared-files-parity.test.ts requires every `files` entry byte-identical in
#     EVERY skeleton, which these two must never be. So the source is resolved per
#     repo, from its marker, through $SKELETON_FOR below.
#   - THE TWO FILES NEED OPPOSITE POLICIES ON AN EXISTING COPY. See $FROM_SKELETON
#     usage in diff_files/stage_repo: `sync` is one-way overwrite (AGENTS.md must
#     not drift -- 68 lines behind in tabsii is #559, the injury this whole
#     mechanism exists for); `seed` creates where absent and never touches it
#     again (CLAUDE.md carries a per-repo "What this repo is" paragraph, and four
#     of the repos being backfilled are not sibling apps at all, so overwriting it
#     would assert in each of them that they are one).
FROM_SKELETON=$(node -e "const m=JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).filesFromSkeleton||{};console.log(Object.entries(m).map(([p,mode])=>p+'='+mode).join('\n'))")
SKELETON_FOR=$(node -e "const m=JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).skeletonForMarker||{};console.log(Object.entries(m).map(([mk,sk])=>mk+'='+sk).join('\n'))")
SKELETON_DEFAULT=$(node -e "const m=JSON.parse(require('fs').readFileSync('$MANIFEST','utf8'));console.log(m.skeletonDefault||'')")

# `mustBeUniform`: the FOURTH list (#1108), and the only one that never writes.
# `path<TAB>baseline` lines -- a path this repo asserts should read identically
# across every repo that holds it, plus the variant count it was measured at
# when declared. See the block comment near the top of this file for why a
# baselined ratchet rather than a hard "must be 1" gate.
UNIFORM=$(node -e "const m=JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).mustBeUniform||{};console.log(Object.entries(m).map(([p,b])=>p+'\t'+b).join('\n'))")

drifted=0
synced=0
current=0
failed=0

# Field separator for the two state files below. A literal tab in a `grep`
# pattern or a `${var%%...}` expansion is invisible in a diff and one editor
# away from becoming spaces.
TAB=$(printf '\t')

applies() {
  # Instances are NOT in scope: they carry biffo.core.json and a
  # core-manifest.json, so `biffo core upgrade` three-way-merges these paths
  # into them. Two mechanisms writing the same files would fight, and the
  # core-ownership guard would refuse this script's commit anyway -- correctly,
  # since these are template-owned paths in an instance.
  [ -f "$1/biffo.core.json" ] && return 1
  for m in $MARKERS; do [ -f "$1/$m" ] && return 0; done
  # Also: any repo already receiving shared distribution. The runner repos, the
  # design repo and tabsii-map have neither marker but are in scope, and a
  # mechanism that distributes a file once and then stops tracking it is the
  # drift this script exists to end -- it would have recreated the exact hole in
  # the exact repos nobody watches.
  #
  # This clause used to test `scripts/verify.sh`, and #1241 moved that file into
  # the CLI package and swept the copies. It was therefore DEAD, and dead in the
  # most misleading way available: all four repos still resolved because their
  # local working trees carried a `verify.sh` that no longer exists on their
  # `origin/dev` -- and all four are checkouts `checkout-audit.sh` reports as
  # parked or behind. The next `git pull` in any of them would have dropped it
  # out of scope silently, shrinking the denominator with no error, which is the
  # #1145 shape AGENTS.md section 2 names: a check that cannot evaluate an input
  # drops it and reports the remainder as the whole.
  #
  # `scripts/biffo.sh` is the successor because it is the bridge every satellite
  # holds and the first entry in `files` -- "already receiving distribution" is
  # exactly what the old clause meant by "already carrying the gate".
  #
  # Read from `origin/<base>`, NOT the working tree, and that distinction is the
  # whole point rather than a detail. #1290 swapped the filename in this clause
  # and kept the `[ -f ... ]`, which dropped all four marker-less repos out of
  # scope on the very next run: their checkouts are parked on `main` or behind
  # (`checkout-audit.sh` reports every one of them), so they hold the PREVIOUS
  # generation's `scripts/verify.sh` and not the bridge. The round went from 14
  # repos to 10 in silence.
  #
  # That is the same defect the swap was meant to fix, one filename later: a
  # scope test against a working tree measures whoever last ran `git pull` on
  # this machine, not the estate. `shared-files.json`'s `mustBeUniform` note
  # already records the identical lesson from the other direction -- it reads
  # `origin/<base>` refs precisely so a stale checkout cannot move the number --
  # and this clause should have been written that way to begin with.
  #
  # The working tree stays as a fallback for a clone with no fetched origin,
  # where the ref genuinely cannot be read and refusing scope would be worse.
  _base=$(resolve_base "$1")
  git -C "$1" rev-parse -q --verify "origin/$_base:scripts/biffo.sh" >/dev/null 2>&1 && return 0
  [ -f "$1/scripts/biffo.sh" ] && return 0
  return 1
}

# Which skeleton is the canonical source of `filesFromSkeleton` entries for this
# repo. Resolved from the repo's own marker, so a plugin repo gets the plugin
# skeleton's ruleset and a sibling gets the sibling one.
#
#   $1  repo directory
#   $2  optional git ref to read the markers from. diff_files must ask
#       origin/<base> (there is no worktree yet, and the primary checkout may be
#       parked anywhere); stage_repo asks the staged worktree, which IS
#       origin/<base>. Reading markers off whichever branch a clone happens to be
#       sitting on is how a drift report ends up describing a different repo than
#       the one that ships.
#
# Repos with NEITHER marker fall through to $SKELETON_DEFAULT. They are in scope
# via the `scripts/biffo.sh` clause in applies() -- the runner repos, tabsii-map
# and tabsii-data-model-design -- and the satellite ruleset applies to them
# unchanged: it is dev-branch, worktrees, commits, PRs, never-merge-red, honest
# pushes and security, with no deploy clause for a repo without a deploy to trim.
skeleton_for() {
  for _pair in $SKELETON_FOR; do
    _marker=${_pair%%=*}
    _skel=${_pair#*=}
    if [ -n "${2:-}" ]; then
      git -C "$1" cat-file -e "$2:$_marker" 2>/dev/null && { printf '%s' "$_skel"; return 0; }
    else
      [ -f "$1/$_marker" ] && { printf '%s' "$_skel"; return 0; }
    fi
  done
  printf '%s' "$SKELETON_DEFAULT"
}

# Fail closed on a manifest that names a source which is not there. `cp` writes
# its complaint to a stderr this script discards, so the repo would receive
# nothing while the run reported success -- the silent-empty-copy failure
# shared-files-parity.test.ts's `filesIfPresent` assertions were written for.
# Checked here too, against every skeleton the marker table can select, because
# the test proves the template's manifest and this proves whatever manifest is
# actually being run.
if [ -n "$FROM_SKELETON" ]; then
  for _pair in $SKELETON_FOR $(printf 'x=%s' "$SKELETON_DEFAULT"); do
    _skel=${_pair#*=}
    [ -n "$_skel" ] || continue
    for _entry in $FROM_SKELETON; do
      _target=${_entry%%=*}
      _mode=${_entry#*=}
      case "$_mode" in
        sync|seed) ;;
        *) echo "filesFromSkeleton['$_target'] must be 'sync' or 'seed', got '$_mode'" >&2; exit 2 ;;
      esac
      [ -f "$TEMPLATE_ROOT/_skeletons/$_skel/$_target" ] || {
        echo "filesFromSkeleton names _skeletons/$_skel/$_target, which does not exist" >&2
        exit 2
      }
    done
  done
fi

# Which branch a repo's shared-set comparisons read against: `dev` if it has
# one, else whatever `origin/HEAD` resolves to, else whatever the clone
# happens to be on. `dev` first, per AGENTS.md section 2 -- it is the
# integration branch in every Biffo repo. `origin/HEAD` is NOT a substitute:
# it points at `main` in several clones, and `main` is a stale release branch
# that legitimately does not carry these files.
#
# Factored out of `diff_files` so `applicable_repo_list` below -- which the
# mustBeUniform ratchet and --candidates both need, and neither of which is
# the drift check -- resolves the SAME branch the same way, rather than a
# second copy of this logic drifting from the first.
resolve_base() {
  d="$1"
  if git -C "$d" rev-parse --verify --quiet origin/dev >/dev/null 2>&1; then
    echo dev
    return
  fi
  b=$(git -C "$d" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
  [ -n "$b" ] || b=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)
  echo "$b"
}

# Sentinel `diff_files` returns when the clone could not be fetched at all,
# as distinct from its files having drifted. Deliberately not a valid path.
UNFETCHABLE='__fetch-failed__'

# Which of the shared files differ in this repo. Missing counts as drifted: a
# repo that never received a file is exactly as unprotected as one holding a
# stale copy, and reporting them differently invites triaging only the second.
diff_files() {
  d="$1"
  out=""
  # Compare against the REPO's integration branch, not the local working copy.
  #
  # The first version read "$d/$f" straight off disk, so a clone that had not
  # been pulled reported DRIFTED for twelve repos that were entirely current --
  # right after their sync PRs merged. The question is "is this repository
  # current", not "is my laptop current", and a drift detector that fires on a
  # stale checkout is one you learn to ignore.
  # --prune, or a merged sync PR breaks this repo's sync permanently (#943).
  # GitHub deletes chore/sync-shared when the PR merges; a plain fetch leaves the
  # local refs/remotes/origin/chore/sync-shared behind, and --force-with-lease
  # below then compares against a ref the remote no longer has and refuses with
  # "stale info". Measured on biffo-runners and tabsii-data-model-design today:
  # both had a tracking ref for a branch that was gone, and both failed every run
  # until pruned. Success was self-limiting -- the first merge poisoned the next
  # sync.
  # `2>/dev/null` used to hide the one failure that matters here. A clone whose
  # refspec is pinned to a branch the remote no longer has — a `--single-branch`
  # clone of `main` after the `main` -> `dev` migration (#1145) — fails with
  # `fatal: couldn't find remote ref refs/heads/main` and therefore **prunes
  # nothing**, so the dead `refs/remotes/origin/main` survives. Everything
  # downstream then reads a ref that no longer exists on the remote: the files
  # are reported against a frozen commit, and phase 2 pushes toward a branch
  # that is gone. Swallowing the error is what makes that silent.
  if ! fetch_err=$(git -C "$d" fetch origin --prune 2>&1); then
    echo "$UNFETCHABLE$(printf '\t')$(printf '%s' "$fetch_err" | tr '\n' ' ')"
    return 0
  fi
  base=$(resolve_base "$d")
  for f in $FILES; do
    remote=$(git -C "$d" show "origin/$base:$f" 2>/dev/null)
    if [ -z "$remote" ]; then
      out="$out $f(missing)"
    elif [ "$remote" != "$(cat "$TEMPLATE_ROOT/$f")" ]; then
      out="$out $f"
    fi
  done
  # Conditional files: absent is NOT drift. A repo with no frontend is not
  # behind on a frontend file, and reporting it as such would make `--check`
  # permanently red in five repos that can never satisfy it.
  if [ -n "$CONDITIONAL" ]; then
    # Captured rather than printed: the `while` runs in a subshell (it is on the
    # right of a pipe), so it cannot append to `$out` directly, and printing
    # straight to stdout would interleave ahead of the line below.
    out="$out$(printf '%s\n' "$CONDITIONAL" | while IFS="$TAB" read -r target source; do
      [ -n "$target" ] || continue
      remote=$(git -C "$d" show "origin/$base:$target" 2>/dev/null)
      [ -n "$remote" ] || continue
      [ "$remote" = "$(cat "$TEMPLATE_ROOT/$source")" ] || printf ' %s' "$target"
    done)"
  fi
  # Skeleton-sourced files. `sync` behaves like `files` -- missing or differing is
  # drift. `seed` reports ONLY missing: a differing copy is the repo exercising
  # the ownership `seed` exists to grant it, and reporting that as drift would
  # make --check permanently red in every repo that wrote its own identity
  # paragraph, i.e. exactly the repos that did the right thing.
  if [ -n "$FROM_SKELETON" ]; then
    skel=$(skeleton_for "$d" "origin/$base")
    for entry in $FROM_SKELETON; do
      target=${entry%%=*}
      mode=${entry#*=}
      remote=$(git -C "$d" show "origin/$base:$target" 2>/dev/null)
      if [ -z "$remote" ]; then
        out="$out $target(missing)"
      elif [ "$mode" = sync ] &&
        [ "$remote" != "$(cat "$TEMPLATE_ROOT/_skeletons/$skel/$target")" ]; then
        out="$out $target"
      fi
    done
  fi
  echo "$out"
}

repo_slug() {
  git -C "$1" remote get-url origin | sed -E 's#.*[:/]([^/]+/[^/]+)$#\1#; s#\.git$##'
}

# The absolute path of a working tree's shared git directory, which is the same
# for a primary checkout and every worktree linked to it -- i.e. an identity for
# the REPOSITORY rather than for one of its working trees.
repo_dir() {
  (cd "$1" 2>/dev/null && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd)
}

TEMPLATE_REPO=$(repo_dir "$TEMPLATE_ROOT")
[ -n "$TEMPLATE_REPO" ] || { echo "$TEMPLATE_ROOT is not a git repository" >&2; exit 2; }

# Refuse to ship from a stale template checkout.
#
# This mechanism reads the SATELLITE side from `origin/<base>` refs, never a
# working tree -- deliberately, because a stale checkout on the measuring
# machine once produced a fake 4-variant reading of api-client.ts. The TEMPLATE
# side had no such protection: every file distributed, and every comparison
# `--check` makes, is read from `$TEMPLATE_ROOT` -- whatever tree you happen to
# be standing in.
#
# That asymmetry bit three times in one session on 2026-08-03:
#   - `--check` reported `1 current` against a manifest two commits old, which
#     is a true statement about the wrong question;
#   - a sweep shipped the PREVIOUS .githooks/pre-push and scripts/verify.sh to
#     14 repos, which would have deleted a guard script while leaving the
#     `[ -f ... ]` caller that warns and continues -- silently disabling the
#     force-push guard estate-wide;
#   - and both times the output looked confident and well-formed, because being
#     behind produces a wrong ANSWER rather than an error.
#
# Only enforced when HEAD is on the integration branch: CI checks out a detached
# merge ref, and a feature branch is a legitimate place to test an unmerged
# change. Exit 2 is "cannot tell", the same convention wait-for-checks.sh and
# branch-health.sh use, and it is never a pass.
_tpl_branch=$(git -C "$TEMPLATE_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
if [ "$_tpl_branch" = "dev" ]; then
  # Only claim "behind" when the fetch actually SUCCEEDED. A clone that cannot
  # reach its remote still has a local `origin/dev` ref, and it can legitimately
  # be behind it -- but "you are behind, run git pull" is the wrong diagnosis
  # for a repo whose fetch just failed, and it masked the real message
  # ("cannot fetch") that shared-sync already prints for exactly that case.
  #
  # Found when #1220 stopped this suite serving a cached pass: two tests that
  # assert the fetch-failure path had been green without running. A guard that
  # answers a question it could not ask is the same defect this preflight
  # exists to catch, one level in.
  if git -C "$TEMPLATE_ROOT" fetch -q origin dev 2>/dev/null; then
    _behind=$(git -C "$TEMPLATE_ROOT" rev-list --count HEAD..origin/dev 2>/dev/null || echo 0)
  else
    _behind=0
  fi
  if [ "${_behind:-0}" -gt 0 ]; then
    echo "shared-sync: this template checkout is $_behind commit(s) behind origin/dev." >&2
    echo "  Everything it would ship, and everything --check compares against, comes from" >&2
    echo "  THIS tree. Run: git pull --ff-only origin dev" >&2
    exit 2
  fi
  # Only on the SHIPPING path. `--check`, `--candidates`, `--backfill` and
  # `--skeleton-adoption` write nothing, and refusing to report on a dirty tree
  # would block the very command you reach for while editing shared files.
  if [ "${CHECK:-0}" = 0 ] && [ "${CANDIDATES:-0}" = 0 ] && [ "${BACKFILL:-0}" = 0 ] &&
    [ "${ADOPTION:-0}" = 0 ] &&
    ! git -C "$TEMPLATE_ROOT" diff --quiet HEAD -- "$MANIFEST" scripts .githooks _skeletons 2>/dev/null; then
    echo "shared-sync: uncommitted changes to distributed paths in this checkout." >&2
    echo "  Shipping them would push content no satellite can trace to a commit." >&2
    echo "  Commit them, or stash with: git stash push -m shared-sync" >&2
    exit 2
  fi
fi

# The repos this run's scope reaches: same selection as the drift survey below
# (applies(), template excluded, --repo honoured), fetched and resolved to
# their base branch. Emitted as `label<TAB>dir<TAB>base`.
#
# A second walk of $ESTATE rather than reusing the drift survey's, because
# neither of this function's two callers -- the mustBeUniform ratchet and
# --candidates -- write anything or open a PR, and both need to run whether or
# not any `files`/`filesIfPresent`/`filesFromSkeleton` entry drifted. The
# repeated `fetch --prune` per repo is a no-op in the common case (the main
# survey below just did it) and cheap in the uncommon one.
applicable_repo_list() {
  for d in "$ESTATE"/*/; do
    d="${d%/}"
    [ -e "$d/.git" ] || continue
    [ "$(repo_dir "$d")" = "$TEMPLATE_REPO" ] && continue
    [ -n "$ONLY" ] && [ "$(basename "$d")" != "$ONLY" ] && continue
    applies "$d" || continue
    git -C "$d" fetch origin --prune --quiet 2>/dev/null
    printf '%s\t%s\t%s\n' "$(basename "$d")" "$d" "$(resolve_base "$d")"
  done
}

# --backfill: the OTHER discovery direction (#1109), advisory-only like
# --candidates.
#
# `--candidates` walks the satellites and asks "what do lots of repos hold that
# the manifest does not govern?". It cannot see this issue's shape at all,
# because it requires a path in >=5 repos: a file the skeleton gained last month
# lives in the one repo scaffolded since, and is invisible at 1 holder.
#
# This walks the SKELETONS and asks the reverse: "what does a skeleton ship that
# some of its repos have and others lack?". Improving a skeleton helps only
# repos scaffolded AFTERWARDS -- existing ones keep whatever it said on the day
# they were born, and until now nothing reported the difference. Four files
# (`auth-gate.tsx`, `cognito-hygiene.ts`, `identity.ts`, `branding.ts`) sat in
# the newest sibling and in none of the four older ones, and nobody had decided
# that; they were simply created earlier.
#
# ## Why PARTIAL adoption specifically, and not "absent everywhere"
#
# Reporting every skeleton path a repo lacks would be noise -- a skeleton is
# full of scaffolding that satellites rename, consume or delete at birth, and a
# report nobody can read is one nobody reads (the argument protection-audit.sh
# makes at length). Partial adoption is the crisp signal: **somebody got this
# file and somebody did not**, which is an inconsistency by construction rather
# than a judgement about what a repo ought to want. A path every applicable repo
# holds is fine; one no applicable repo holds is probably scaffolding. Between
# them is the gap this issue is about.
#
# Paths already in any of the four manifest lists are skipped -- they have a
# channel, and `--check` is the thing that reports on them.
#
# Reads `origin/<base>` via ls-tree, never a working tree, for the reason
# recorded against --check: a guard that fails on somebody's stale checkout is a
# fail-closed nuisance people learn to ignore.
#
# Exits 0 unconditionally. Backfilling is a decision -- `files` CREATES what is
# absent (`mkdir -p` + `cp` in stage_repo), so adding a path to the shared set is
# all it takes mechanically, but whether a given repo SHOULD receive a given
# file is a human call. `auth-gate.tsx` is the standing example: it interacts
# with each sibling's existing auth flow and must not be dropped in blind.
if [ -n "$BACKFILL" ]; then
  repos=$(applicable_repo_list)
  if [ -z "$repos" ]; then
    printf '\nno applicable repos found under %s\n\n' "$ESTATE"
    exit 0
  fi

  rows=$(mktemp)
  trap 'rm -f "$rows"; wt_log_run_end' EXIT
  # `<skeleton><TAB><repo><TAB><path>` for every path every applicable repo
  # holds, tagged with the skeleton that repo would be scaffolded from now.
  printf '%s\n' "$repos" | while IFS="$TAB" read -r label d base; do
    [ -n "$d" ] || continue
    # Only repos carrying an actual marker. `skeleton_for` falls back to
    # $SKELETON_DEFAULT for marker-less repos, and using that here would be
    # wrong rather than merely noisy: the fallback exists so `filesFromSkeleton`
    # can deliver AGENTS.md/CLAUDE.md to the runner fleets, tabsii-map and
    # tabsii-data-model-design -- it is not a claim that those repos were
    # scaffolded from the sibling skeleton. Comparing them against its full tree
    # reported `services/api/*` as "7 have / 5 lack" across five repos that will
    # never hold a FastAPI service, drowning the 20 real gaps in 39 fictional
    # ones. A detector nobody can read is one nobody reads.
    _skel=""
    for _pair in $SKELETON_FOR; do
      _marker=${_pair%%=*}
      if git -C "$d" cat-file -e "origin/$base:${_marker}" 2>/dev/null; then
        _skel=${_pair#*=}
        break
      fi
    done
    [ -n "$_skel" ] || continue
    git -C "$d" ls-tree -r --name-only "origin/$base" 2>/dev/null |
      sed "s|^|${_skel}${TAB}${label}${TAB}|"
  done > "$rows"

  # The skeletons' own file lists, same shape: `<skeleton><TAB><path>`.
  skelrows=$(mktemp)
  trap 'rm -f "$rows" "$skelrows"; wt_log_run_end' EXIT
  # $TEMPLATE_ROOT, not $TEMPLATE_REPO: the latter is repo_dir()'s output, i.e.
  # the .git COMMON DIR, and `<...>/.git/_skeletons/*/` matches nothing. The
  # first cut of this used it and reported a confident `0 backfill gap(s)` --
  # a zero that meant "could not see the input", which is the exact defect this
  # estate keeps finding. Hence the fail-closed check below.
  for _dir in "$TEMPLATE_ROOT"/_skeletons/*/; do
    [ -d "$_dir" ] || continue
    _name=$(basename "$_dir")
    # `git ls-tree`, NOT `find`. `find` walks the WORKING TREE, so it reports
    # every gitignored artefact a skeleton happens to be carrying on this
    # machine -- a `.venv/` left behind by one diagnostic run turned this
    # report from 29 rows into **10,994**, burying every real finding under
    # site-packages. Those files are not shipped to anybody: the satellites
    # are measured with `ls-tree` against `origin/<base>` (see the comment
    # above `applicable_repo_list`), so enumerating the skeleton from a
    # checkout compared paths that can never match by construction.
    #
    # Third instance of this class in one day: `auth.ts` measured 6 variants
    # from working trees where `origin/dev` had 2, and a branch was judged
    # unpushed from a stale local ref. Read refs, not checkouts.
    git -C "$TEMPLATE_ROOT" ls-tree -r --name-only HEAD -- "_skeletons/${_name}/" |
      sed "s|^_skeletons/${_name}/||" |
      sed "s|^|${_name}${TAB}|" >> "$skelrows"
  done

  # An empty skeleton list can only mean the walk above is broken -- this repo
  # always has skeletons. Reporting "no gaps" from it would be a pass earned by
  # reading nothing.
  if [ ! -s "$skelrows" ]; then
    echo "no skeleton files found under $TEMPLATE_ROOT/_skeletons -- refusing to report zero gaps" >&2
    exit 2
  fi

  node -e '
    const fs = require("fs")
    const [manifestPath, rowsPath, skelPath] = process.argv.slice(1)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    // Already governed by a list => already triaged, one way or the other.
    const known = new Set([
      ...(manifest.files || []),
      ...Object.keys(manifest.filesIfPresent || {}),
      ...Object.keys(manifest.filesFromSkeleton || {}),
      ...Object.keys(manifest.mustBeUniform || {}),
    ])

    const split = (line) => {
      const parts = line.split("\t")
      return parts.length < 2 ? null : parts
    }

    // skeleton -> Set(path)
    const skelFiles = new Map()
    for (const line of fs.readFileSync(skelPath, "utf8").split("\n")) {
      const p = line && split(line)
      if (!p) continue
      const [skel, ...rest] = p
      const path = rest.join("\t")
      if (!path) continue
      if (!skelFiles.has(skel)) skelFiles.set(skel, new Set())
      skelFiles.get(skel).add(path)
    }

    // skeleton -> repo -> Set(path)
    const held = new Map()
    for (const line of fs.readFileSync(rowsPath, "utf8").split("\n")) {
      const p = line && split(line)
      if (!p) continue
      const [skel, repo, ...rest] = p
      const path = rest.join("\t")
      if (!path) continue
      if (!held.has(skel)) held.set(skel, new Map())
      const byRepo = held.get(skel)
      if (!byRepo.has(repo)) byRepo.set(repo, new Set())
      byRepo.get(repo).add(path)
    }

    console.log("\nskeleton backfill gaps -- paths some of a skeleton'"'"'s repos have and others lack (advisory only, #1109)")
    let total = 0
    for (const [skel, byRepo] of [...held].sort()) {
      const paths = skelFiles.get(skel)
      const repos = [...byRepo.keys()].sort()
      if (!paths || repos.length < 2) continue
      const rows = []
      for (const path of paths) {
        if (known.has(path)) continue
        const lack = repos.filter((r) => !byRepo.get(r).has(path))
        const have = repos.length - lack.length
        // Partial adoption only: everybody-has is fine, nobody-has is
        // scaffolding the repos were meant to consume or rename.
        if (have === 0 || lack.length === 0) continue
        rows.push({ path, have, lack })
      }
      rows.sort((a, b) => b.have - a.have || a.path.localeCompare(b.path))
      total += rows.length
      console.log(`\n${skel} -- ${repos.length} repos, ${paths.size} skeleton files, ${rows.length} gap(s)\n`)
      for (const r of rows) {
        console.log(`  ${r.path.padEnd(48)} ${r.have} have / ${r.lack.length} lack   ${r.lack.join(", ")}`)
      }
    }
    console.log(`\n${total} backfill gap(s) total.`)
    console.log("Nothing here fails the build. `files` creates what is absent, so backfilling is")
    console.log("\"add the path to shared-files.json\" -- but whether a repo SHOULD receive a given")
    console.log("file is a human call. See AGENTS.md section 9, \"Reconcile before you distribute\".")
  ' "$MANIFEST" "$rows" "$skelrows"
  printf '\n'
  exit 0
fi

# --skeleton-adoption: the class fix for #1271 -- see the block comment near
# the top of this file for why `--candidates` cannot see this shape.
#
# Walks the same two inputs `--backfill` does (what applicable repos hold, and
# what the skeletons own) but asks a stricter question with no threshold at
# all: for every path a repo skeleton owns, is it held by EVERY repo that
# skeleton applies to? `--backfill` deliberately drops the "0 repos have it"
# case as scaffolding noise; this mode deliberately keeps it, because for
# adoption tracking specifically, a skeleton path nobody has adopted yet is
# the loudest signal there is, not noise to filter.
#
# Advisory only, like `--candidates` and `--backfill` -- always exits 0. Some
# gaps this reports are deliberate (a per-app file that must NOT converge, or
# scaffolding meant to be deleted at birth) and that is a human decision to
# record, not something this report should guess by pattern-matching paths.
if [ -n "$ADOPTION" ]; then
  repos=$(applicable_repo_list)
  if [ -z "$repos" ]; then
    printf '\nno applicable repos found under %s\n\n' "$ESTATE"
    exit 0
  fi

  # `<skeleton><TAB><repo><TAB><path>` for every path every applicable repo
  # holds, tagged with the skeleton that repo would be scaffolded from now --
  # identical shape and reasoning to `--backfill`'s $rows above.
  rows=$(mktemp)
  trap 'rm -f "$rows"; wt_log_run_end' EXIT
  printf '%s\n' "$repos" | while IFS="$TAB" read -r label d base; do
    [ -n "$d" ] || continue
    _skel=""
    for _pair in $SKELETON_FOR; do
      _marker=${_pair%%=*}
      if git -C "$d" cat-file -e "origin/$base:${_marker}" 2>/dev/null; then
        _skel=${_pair#*=}
        break
      fi
    done
    # Marker-less repos are skipped, same as --backfill and for the same
    # reason: $SKELETON_DEFAULT exists so `filesFromSkeleton` can deliver
    # AGENTS.md/CLAUDE.md to the runner fleets, tabsii-map and
    # tabsii-data-model-design, not as a claim that those repos were
    # scaffolded from a repo skeleton. Comparing them against a full skeleton
    # tree would invent gaps in repos that will never hold the paths in
    # question.
    [ -n "$_skel" ] || continue
    git -C "$d" ls-tree -r --name-only "origin/$base" 2>/dev/null |
      sed "s|^|${_skel}${TAB}${label}${TAB}|"
  done > "$rows"

  # Which `_skeletons/*/` directories are actual REPO skeletons, discovered
  # rather than named. The discriminator is "ships a CI workflow" -- the same
  # test `cli/src/lib/skeleton-governance-workflows.test.ts` uses (merged in
  # #1274) -- not a hardcoded name list. `_skeletons/registry/` is
  # plugin-registry *content* (`plugins.json` and its schema, consumed by the
  # plugin store), never scaffolded into a repo, and ships no
  # `.github/workflows/ci.yml` -- so it is excluded by what it IS rather than
  # by an exception someone has to remember to add when a new content-only
  # directory shows up under `_skeletons/`.
  skelrows=$(mktemp)
  skeltokens=$(mktemp)
  trap 'rm -f "$rows" "$skelrows" "$skeltokens"; wt_log_run_end' EXIT
  for _dir in "$TEMPLATE_ROOT"/_skeletons/*/; do
    [ -d "$_dir" ] || continue
    [ -f "$_dir/.github/workflows/ci.yml" ] || continue
    _name=$(basename "$_dir")
    # `git ls-tree`, NOT `find`. `find` walks the WORKING TREE, so it reports
    # every gitignored artefact a skeleton happens to be carrying on this
    # machine -- a `.venv/` left behind by one diagnostic run turned this
    # report from 29 rows into **10,994**, burying every real finding under
    # site-packages. Those files are not shipped to anybody: the satellites
    # are measured with `ls-tree` against `origin/<base>` (see the comment
    # above `applicable_repo_list`), so enumerating the skeleton from a
    # checkout compared paths that can never match by construction.
    #
    # Third instance of this class in one day: `auth.ts` measured 6 variants
    # from working trees where `origin/dev` had 2, and a branch was judged
    # unpushed from a stale local ref. Read refs, not checkouts.
    # `.scaffold-tokens.json` is skeleton METADATA -- it configures this very
    # report rather than shipping to a scaffolded repo, so counting it as an
    # adoption gap asks why no satellite "adopted" the config file describing
    # what gets renamed. Found by the ratchet flagging its own arrival one merge
    # after it was added: the check that verified this feature ran while the
    # file was still untracked, so `ls-tree` could not yet see it.
    git -C "$TEMPLATE_ROOT" ls-tree -r --name-only HEAD -- "_skeletons/${_name}/" |
      sed "s|^_skeletons/${_name}/||" |
      grep -v '^\.scaffold-tokens\.json$' |
      sed "s|^|${_name}${TAB}|" >> "$skelrows"
    # Tokens `biffo plugin create` rewrites when it scaffolds this skeleton.
    # A path containing one is TEMPLATE PAYLOAD: `src/example_plugin/main.py`
    # becomes `src/idea_scout/main.py` in a real plugin, so no scaffolded repo
    # can ever hold the skeleton's spelling of it. Reporting that as a 0/N
    # adoption gap is a false positive -- it is a file that did its job.
    # Declared by the skeleton, never guessed from the path, and kept honest by
    # cli/src/lib/scaffold-tokens-parity.test.ts.
    if [ -f "$_dir/.scaffold-tokens.json" ]; then
      node -e "
        const t = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).tokens || []
        for (const tok of t) console.log(process.argv[2] + '\t' + tok)
      " "$_dir/.scaffold-tokens.json" "$_name" >> "$skeltokens"
    fi
  done

  # An empty result can only mean the discriminator or the walk above is
  # broken -- this repo always has at least the sibling and plugin skeletons,
  # and both always ship ci.yml. Reporting "nothing to report" from it would
  # be a pass earned by reading nothing, the exact shape #1218 and #1270
  # record for other fail-opens in this estate.
  if [ ! -s "$skelrows" ]; then
    echo "no repo skeletons found under $TEMPLATE_ROOT/_skeletons (ships .github/workflows/ci.yml) -- refusing to report zero gaps" >&2
    exit 2
  fi

  node -e '
    const fs = require("fs")
    const [rowsPath, skelPath, tokensPath, manifestPath] = process.argv.slice(1)

    // skeleton -> [token]; empty when a skeleton declares none.
    const tokens = new Map()
    for (const line of fs.readFileSync(tokensPath, "utf8").split("\n")) {
      const p = line && line.split("\t")
      if (!p || p.length < 2) continue
      if (!tokens.has(p[0])) tokens.set(p[0], [])
      tokens.get(p[0]).push(p[1])
    }
    const isPayload = (skel, path) => (tokens.get(skel) || []).some((t) => path.includes(t))

    // path -> baseline holder count. Pre-existing residue never blocks; only a
    // REGRESSION does. Same posture as `mustBeUniform` and the core-upgrade
    // orphan ratchet -- a guard that is red on the pre-existing set every
    // morning is one people learn to scroll past.
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    const baselines = manifest.skeletonAdoption || {}

    const split = (line) => {
      const parts = line.split("\t")
      return parts.length < 2 ? null : parts
    }

    // skeleton -> Set(path)
    const skelFiles = new Map()
    for (const line of fs.readFileSync(skelPath, "utf8").split("\n")) {
      const p = line && split(line)
      if (!p) continue
      const [skel, ...rest] = p
      const path = rest.join("\t")
      if (!path) continue
      if (!skelFiles.has(skel)) skelFiles.set(skel, new Set())
      skelFiles.get(skel).add(path)
    }

    // skeleton -> repo -> Set(path)
    const held = new Map()
    for (const line of fs.readFileSync(rowsPath, "utf8").split("\n")) {
      const p = line && split(line)
      if (!p) continue
      const [skel, repo, ...rest] = p
      const path = rest.join("\t")
      if (!path) continue
      if (!held.has(skel)) held.set(skel, new Map())
      const byRepo = held.get(skel)
      if (!byRepo.has(repo)) byRepo.set(repo, new Set())
      byRepo.get(repo).add(path)
    }

    const payload = []
    const regressions = []
    const unbaselined = []
    const improvements = []
    console.log("\nskeleton adoption -- every path a skeleton owns, and whether every applicable repo holds it (advisory only, enumerated not thresholded, #1271)")
    let total = 0
    for (const [skel, byRepo] of [...held].sort()) {
      const paths = skelFiles.get(skel)
      const repos = [...byRepo.keys()].sort()
      if (!paths || repos.length === 0) continue
      const rows = []
      for (const path of paths) {
        const lack = repos.filter((r) => !byRepo.get(r).has(path))
        const have = repos.length - lack.length
        // No threshold anywhere, and -- unlike --backfill -- the 0-holders
        // case is NOT skipped. --backfill treats "nobody has it" as
        // scaffolding a repo consumes or deletes at birth; here it is the
        // clearest possible instance of "not held by all", which is the
        // whole question this mode answers.
        if (lack.length === 0) continue
        if (isPayload(skel, path)) { payload.push({ skel, path }); continue }
        rows.push({ path, have, lack })
      }
      rows.sort((a, b) => a.have - b.have || a.path.localeCompare(b.path))
      total += rows.length
      console.log(`\n${skel} -- ${repos.length} applicable repo(s), ${paths.size} skeleton path(s), ${rows.length} not held by all\n`)
      for (const r of rows) {
        const base = baselines[`${skel}:${r.path}`]
        let flag = ""
        if (base === undefined) {
          flag = "   [NEW -- no baseline]"
          unbaselined.push(`${skel}:${r.path}`)
        } else if (r.have < base) {
          flag = `   [REGRESSED from ${base}]`
          regressions.push(`${skel}:${r.path} -- ${r.have}/${repos.length}, baseline ${base}`)
        } else if (r.have > base) {
          flag = `   [IMPROVED from ${base} -- tighten the baseline]`
          improvements.push(`${skel}:${r.path} -- ${r.have}, baseline ${base}`)
        }
        console.log(`  ${r.path.padEnd(48)} ${r.have}/${repos.length} hold it   lacking: ${r.lack.join(", ")}${flag}`)
      }
    }

    if (payload.length) {
      console.log(`\ntemplate payload -- renamed by \`biffo plugin create\`, so 0 adoption is CORRECT (${payload.length} path(s))\n`)
      for (const p of payload.sort((a, b) => a.path.localeCompare(b.path))) {
        console.log(`  ${p.path.padEnd(48)} (${p.skel} rewrites this at scaffold time)`)
      }
      console.log("\n  Declared by the skeleton in .scaffold-tokens.json, never guessed from the path.")
      console.log("  Deleting these would break `biffo plugin create` -- there would be nothing to rename.")
    }

    console.log(`\n${total} skeleton-owned path(s) not held by every applicable repo.`)

    // The ratchet. Pre-existing residue never blocks; a regression does, and so
    // does a NEW unadopted path with no recorded baseline -- otherwise a
    // skeleton could gain a file nobody adopts and the gate would never notice,
    // which is the #1271 blind spot reappearing one level up.
    if (regressions.length) {
      console.log("\nADOPTION REGRESSED -- a repo that held these no longer does:")
      for (const r of regressions) console.log(`  ${r}`)
    }
    if (unbaselined.length) {
      console.log("\nNEW unadopted skeleton path(s) with no baseline in shared-files.json:")
      for (const u of unbaselined) console.log(`  ${u}`)
      console.log("  Record a baseline (or adopt it everywhere). A skeleton file nobody takes is")
      console.log("  exactly what --candidates could never see.")
    }
    if (improvements.length) {
      console.log("\nImproved -- lower these baselines, or the ratchet stops meaning anything:")
      for (const i of improvements) console.log(`  ${i}`)
    }
    if (regressions.length || unbaselined.length) process.exit(1)
  ' "$rows" "$skelrows" "$skeltokens" "$MANIFEST"
  _adoption_status=$?
  printf '\n'
  exit "$_adoption_status"
fi

# --candidates: advisory discovery, never the guard (#1108). Walks every
# applicable repo's FULL tree at its base branch -- not just the paths already
# in shared-files.json -- and reports paths held in >=5 repos that are not
# listed anywhere in the manifest, bucketed by how far apart the copies are.
# Exits 0 unconditionally: this is a question for a human to triage into
# `mustBeUniform` (diverging) or `files`/`filesIfPresent` (already uniform),
# never a build failure.
if [ -n "$CANDIDATES" ]; then
  repos=$(applicable_repo_list)
  if [ -z "$repos" ]; then
    printf '\nno applicable repos found under %s\n\n' "$ESTATE"
    exit 0
  fi

  rows=$(mktemp)
  trap 'rm -f "$rows"; wt_log_run_end' EXIT
  printf '%s\n' "$repos" | while IFS="$TAB" read -r label d base; do
    [ -n "$d" ] || continue
    # `ls-tree -r` lines are `<mode> <type> <sha><TAB><path>`. The sed rewrites
    # that to `<sha><TAB><path>` -- BRE, no `-E`, for the same portability
    # reason the rest of this file avoids GNU-only sed flags -- then a second
    # pass prepends the repo label. The blob SHA is the content identity: two
    # repos holding byte-identical bytes at a path always share it, so
    # counting DISTINCT shas per path is exactly counting variants, without
    # ever reading a file's bytes into this shell.
    git -C "$d" ls-tree -r "origin/$base" 2>/dev/null |
      sed "s/^[0-9]* [a-z]* \([0-9a-f]*\)${TAB}/\1${TAB}/" |
      sed "s/^/${label}${TAB}/"
  done > "$rows"

  node -e '
    const fs = require("fs")
    const [manifestPath, rowsPath, thresholdArg] = process.argv.slice(1)
    const threshold = Number(thresholdArg)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    // Anything already governed by one of the other three lists is not a
    // candidate -- it has already been triaged, one way or the other.
    const known = new Set([
      ...(manifest.files || []),
      ...Object.keys(manifest.filesIfPresent || {}),
      ...Object.keys(manifest.filesFromSkeleton || {}),
      ...Object.keys(manifest.mustBeUniform || {}),
    ])

    const byPath = new Map() // path -> Map(repoLabel -> blobSha)
    for (const line of fs.readFileSync(rowsPath, "utf8").split("\n")) {
      if (!line) continue
      const t1 = line.indexOf("\t")
      const t2 = line.indexOf("\t", t1 + 1)
      if (t1 < 0 || t2 < 0) continue
      const repo = line.slice(0, t1)
      const sha = line.slice(t1 + 1, t2)
      const path = line.slice(t2 + 1)
      if (!path) continue
      if (!byPath.has(path)) byPath.set(path, new Map())
      byPath.get(path).set(repo, sha)
    }

    const uniform = []
    const low = []
    const high = []
    for (const [path, repoMap] of byPath) {
      if (known.has(path)) continue
      const holders = repoMap.size
      if (holders < threshold) continue
      const variants = new Set(repoMap.values()).size
      const entry = { path, holders, variants }
      if (variants === 1) uniform.push(entry)
      else if (variants <= 3) low.push(entry)
      else high.push(entry)
    }
    const bySize = (a, b) => b.holders - a.holders || a.path.localeCompare(b.path)
    for (const list of [uniform, low, high]) list.sort(bySize)

    const total = uniform.length + low.length + high.length
    console.log(`\nshared-set candidates -- unlisted paths in >=${threshold} repos (advisory only, #1108)\n`)
    const section = (label, list) => {
      console.log(`${label} (${list.length})`)
      for (const e of list) {
        console.log(`  ${e.path.padEnd(60)} ${e.variants} variant(s) across ${e.holders} repos`)
      }
      console.log("")
    }
    section("uniform but unlisted -- candidates for `files`/`filesIfPresent`", uniform)
    section("2-3 variants -- reconcile before listing, then a `mustBeUniform` candidate", low)
    section("4+ variants -- likely per-repo by design; read each before assuming otherwise", high)
    console.log(`${total} unlisted candidate path(s) total.`)
    console.log("Nothing here fails the build -- triage by hand into shared-files.json, see AGENTS.md section 9.")
  ' "$MANIFEST" "$rows" 5
  printf '\n'
  exit 0
fi

# Phase 1: put the candidate files in place and make the repo ready to run its
# own gate against them. Deliberately stops short of committing anything -- a
# staged worktree is a question ("would this land?"), and until phase 2 it has no
# commit, no push and no PR.
stage_repo() {
  d="$1"
  label="$2"
  base="$3"

  # --prune for the same reason as the drift check above (#943).
  git -C "$d" fetch origin --prune --quiet || return 1
  wt="$d/.worktrees/shared-sync"
  wt_log remove-pre-stage "$label" "$wt"
  git -C "$d" worktree remove --force "$wt" 2>/dev/null
  # `branch -D` reports on STDOUT, so a quiet run printed "Deleted branch
  # chore/sync-shared" in the middle of the rehearsal table.
  git -C "$d" branch -D chore/sync-shared >/dev/null 2>&1
  git -C "$d" worktree add -q "$wt" -b chore/sync-shared "origin/$base" || {
    wt_log add-FAILED "$label" "$wt"
    return 1
  }
  wt_log add "$label" "$wt"

  for f in $FILES; do
    mkdir -p "$wt/$(dirname "$f")"
    cp "$TEMPLATE_ROOT/$f" "$wt/$f"
    chmod +x "$wt/$f" 2>/dev/null
  done

  # Conditional files: overwrite where the repo already has one, never create.
  # No `mkdir -p` and no `chmod +x` -- the directory existing IS the condition,
  # and marking a TypeScript module executable would put a spurious mode change
  # in every sync PR.
  if [ -n "$CONDITIONAL" ]; then
    printf '%s\n' "$CONDITIONAL" | while IFS="$TAB" read -r target source; do
      [ -n "$target" ] || continue
      [ -f "$wt/$target" ] || continue
      cp "$TEMPLATE_ROOT/$source" "$wt/$target"
    done
  fi

  # Skeleton-sourced files, from the skeleton matching THIS repo's flavour.
  # `sync` overwrites unconditionally; `seed` writes only where the file is
  # absent, so a repo that has made its copy its own keeps it forever.
  if [ -n "$FROM_SKELETON" ]; then
    _skel=$(skeleton_for "$wt")
    for _entry in $FROM_SKELETON; do
      _target=${_entry%%=*}
      _mode=${_entry#*=}
      if [ "$_mode" = seed ] && [ -f "$wt/$_target" ]; then continue; fi
      mkdir -p "$wt/$(dirname "$_target")"
      cp "$TEMPLATE_ROOT/_skeletons/$_skel/$_target" "$wt/$_target"
    done
  fi

  # Stamp the version these files CAME FROM, so a repo can say which template
  # its gate is, without a template clone or a network call (#869, H5 gap 1).
  #
  # Read from $TEMPLATE_ROOT, never from $wt. H5 pre-registered this as the most
  # likely way to make the whole thing meaningless: a stamp generated from the
  # RECEIVING repo always matches itself and reports perfect health forever --
  # the shape of every instrument defect found on 2026-07-29. The test asserts
  # the two differ.
  _tv=$(git -C "$TEMPLATE_ROOT" describe --tags --match 'core-v*' --abbrev=0 2>/dev/null || echo unknown)
  printf '%s\n' "$_tv" > "$wt/.biffo-shared-version"

  # Install the JS/Python deps the gate will now check, or its own pre-push
  # correctly refuses this push -- and reaching for BIFFO_SKIP_VERIFY to ship a
  # gate would be the counter-metric H4 pre-registered as refuting itself.
  # The ROOT package too, not only the nested ones. The first version matched
  # `--dir` paths only, so a repo whose package.json is at the root -- tabsii-map
  # -- got no install and the gate refused the push with `tsc: not found`. It
  # then reported GATE REFUSED, which was true and useless: the gate was right,
  # the installer had skipped the one layout it could not see.
  [ -f "$wt/package.json" ] && (cd "$wt" && pnpm install --frozen-lockfile >/dev/null 2>&1 || true)
  [ -f "$wt/pyproject.toml" ] && (cd "$wt" && uv sync --all-groups >/dev/null 2>&1 || true)
  for p in $( (cd "$wt" && sh scripts/biffo.sh verify --list 2>/dev/null) | grep -oE '\-\-dir(ectory)? \./[A-Za-z0-9_./-]+' | awk '{print $2}' | sort -u); do
    (cd "$wt/$p" 2>/dev/null && { pnpm install --frozen-lockfile >/dev/null 2>&1 ||
      pnpm install --frozen-lockfile --ignore-workspace >/dev/null 2>&1 ||
      uv sync --all-groups >/dev/null 2>&1; }) || true
  done

  # THEN every other nested package, discovered from the tree rather than from
  # what the gate happens to announce.
  #
  # The loop above can only see directories `verify --list` names with its own
  # `--directory` flag. A repo whose gate reaches a nested package through its
  # OWN package.json scripts is invisible to it -- `tabsii-crm` runs
  # `pnpm --dir apps/frontend run lint|typecheck|test` from the root manifest,
  # so `verify --list` emits only `--directory ./services/api` and
  # `apps/frontend` never got installed. Its frontend is not a pnpm workspace
  # member either, so the root install above does not reach it.
  #
  # The gate then failed with `vitest: not found` and the round reported
  # `verify failed: lint typecheck test` -- which reads as drift in the
  # candidate files and is nothing of the kind. On 2026-08-06 that FALSE
  # FAILURE blocked a whole estate round for thirteen healthy repos, and the
  # staged tree it left behind passed every check the moment deps were
  # installed by hand (632 tests).
  #
  # This is the third layout the installer could not see -- `tabsii-map`'s
  # root-level package is recorded above, and this is the same shape one level
  # in. Enumerating the tree ends the class rather than adding a third special
  # case: anything with a package.json gets an install attempt, so a layout
  # nobody has thought of yet is covered too.
  #
  # Bounded deliberately: -maxdepth 3 covers `apps/<name>` and `services/<name>`
  # without walking a deep tree, `node_modules` is pruned (or the walk finds
  # thousands of vendored manifests), and the root is skipped because it is
  # already installed above. Failure stays non-fatal -- a package that cannot
  # install is the GATE's problem to report, not the installer's to hide.
  for p in $(cd "$wt" && find . -maxdepth 3 -name node_modules -prune -o -name package.json -print 2>/dev/null |
    sed 's|/package.json$||' | grep -v '^\.$' | sort -u); do
    [ -d "$wt/$p/node_modules" ] && continue
    (cd "$wt/$p" 2>/dev/null && { pnpm install --frozen-lockfile >/dev/null 2>&1 ||
      pnpm install --frozen-lockfile --ignore-workspace >/dev/null 2>&1; }) || true
  done

  git -C "$wt" add -A
  if git -C "$wt" diff --cached --quiet; then
    wt_log remove-nothing-to-sync "$label" "$wt"
    git -C "$d" worktree remove --force "$wt" 2>/dev/null
    return 2
  fi
  return 0
}

# Phase 1's actual question: with the candidate files in place, does this repo's
# gate still work HERE?
#
# This is the check the estate did not have. `--check` compares bytes, and
# `gate-coverage.sh --estate` measures repos as they ARE -- neither can say
# anything about a file that has not been distributed yet. Six of the seven
# rounds on 2026-07-29 were fixing defects that only exist in a repo that is not
# this one: a check list tuned to the template's layout, a pytest-cov flag a
# plugin repo rejects, a package.json that is not at the root.
rehearse_repo() {
  wt="$1"

  # `sh`, not `bash`: this is exactly how `.githooks/pre-push` invokes it
  # (`exec sh scripts/biffo.sh verify`), and /bin/sh is dash on every machine in
  # this estate. A gate proven under one shell and run under another is not the
  # same gate -- `js-dependency-audit.sh` reported INCONCLUSIVE on every
  # invocation while exiting 0 for exactly that reason, because dash's `echo`
  # interprets backslash escapes and bash's does not (#883).
  #
  # Through the BRIDGE, not `scripts/verify.sh` directly. #1241 moved the gate
  # into the versioned CLI package and swept the satellites' copies, so from
  # 2026-08-03 19:25 this line ran `sh: 0: cannot open scripts/verify.sh` in
  # every repo -- and because the rehearsal refuses the whole round when any
  # target fails, shared-file distribution was DOWN estate-wide from that
  # moment. Nothing reported it, because nothing runs a round on a schedule; it
  # surfaced on the first round attempted afterwards, by which time all 14 repos
  # were drifted. Keeping this identical to what pre-push runs is the invariant
  # the comment above already asserts -- it just stopped being true when the
  # gate moved and its callers did not.
  _out=$( (cd "$wt" && sh scripts/biffo.sh verify 2>&1) )
  _rc=$?
  _checks=$(printf '%s' "$_out" | sed -n 's/.*verify passed[^-]*- *//p' | head -1)

  # `gate-coverage.sh` reads `--list` rather than running anything, so it is
  # cheap, and it answers the question `verify.sh` cannot: the gate ran without
  # error, but how much of THIS repo's CI did it mirror? A gate can exit 0
  # having covered 1 kind in 8 -- that IS #855, and it is invisible in an exit
  # code. Reported, not enforced: what coverage number should block a
  # distribution is H5's call to make with numbers, not this script's to assume.
  #
  # Match its three verdicts, not just the fraction. Reading only `N/M` reported
  # a bare `?` for tabsii-map, which has no ci.yml at all -- so the one repo
  # where the coverage question does not apply looked like the one repo where the
  # measurement had failed. "Not applicable" and "could not tell" are different
  # answers, and this file exists because conflating them is expensive.
  # The TEMPLATE's own canonical copy, run against the staged worktree. Not the
  # satellite's copy (it no longer has one, #1109) and not through its bridge
  # either: that would make every rehearsal resolve `npx @biffo/cli@<pin>` once
  # per repo, turning a local measurement into 14 network round trips -- and
  # tying the rehearsal's ability to measure to the registry being reachable.
  _cov=$( (cd "$wt" && sh "$TEMPLATE_ROOT/scripts/gate-coverage.sh" 2>&1) |
    sed 's/\x1b\[[0-9;]*m//g' |
    grep -oE '([0-9]+/[0-9]+|no CI to mirror|NO GATE)' | head -1)
  [ -n "$_cov" ] || _cov='coverage unknown'
  case "$_cov" in
    */*) _cov="covers $_cov" ;;
  esac

  if [ "$_rc" -eq 0 ]; then
    case "$_out" in
      *"verify ran NOTHING"*)
        # verify.sh has already established this is not the #855 bug: no
        # `.github/workflows/ci.yml`, so this repo has no CI for the gate to
        # mirror and no shift-left obligation. Reporting it as a pass would be
        # the exact conflation the gate itself refuses to make, so it gets its
        # own verdict.
        printf '%s\t%s\n' NO-CI 'gate ran nothing; repo has no ci.yml' ;;
      *)
        printf '%s\t%s\n' PASS "$(printf '%s (%s)' "$_checks" "$_cov")" ;;
    esac
    return 0
  fi
  _why=$(printf '%s' "$_out" | grep -E 'verify failed|verify ran NOTHING' | head -1)
  [ -n "$_why" ] || _why=$(printf '%s' "$_out" | tail -1)
  printf '%s\t%s\n' FAIL "$(printf '%s' "$_why" | sed 's/\x1b\[[0-9;]*m//g')"
  return 1
}

# Phase 2: commit the already-staged worktree, push it, open the PR. Reached only
# when phase 1 came back clean for EVERY repo in this run.
# Phase 1 staged a worktree for this repo; refuse to run phase 2 without it.
#
# On 2026-08-02 two repos in a 13-repo round reached phase 2 with the staged
# worktree gone. Every `git -C "$wt" ...` below then failed with
# `fatal: cannot change to '<path>': No such file or directory`, twice, and the
# run attributed those to the PUSH -- the last step it tried -- rather than to
# the first thing that was wrong. The wording sent a whole session after
# push and permissions problems before the real condition was noticed.
#
# The cause is still unknown and tracked in #1160. This does not fix it. It
# makes the failure state its own name, which is worth having regardless of
# which mechanism removes the worktree: a blunt diagnosis costs less than a
# confident wrong one.
require_staged_worktree() {
  _wt="$1"
  _label="$2"
  [ -d "$_wt" ] && return 0
  # The event this whole log exists for (#1160): read the lines above it for a
  # `remove-*` on this path from another pid, and the mystery is over.
  wt_log MISSING-AT-SHIP "$_label" "$_wt"
  printf '%-26s \033[31mstaged worktree missing\033[0m at %s\n' "$_label" "$_wt" >&2
  printf '%-26s   phase 1 staged it and it was gone by phase 2. Nothing was\n' '' >&2
  printf '%-26s   pushed for this repo, and no PR was opened. Cause unknown -\n' '' >&2
  printf '%-26s   see biffo-template#1160 before assuming it is the push.\n' '' >&2
  return 1
}

ship_repo() {
  d="$1"
  label="$2"
  slug="$3"
  base="$4"
  wt="$d/.worktrees/shared-sync"

  require_staged_worktree "$wt" "$label" || return 1

  git -C "$wt" -c commit.gpgsign=false commit -q --no-verify -m "chore(shared): sync template-shared files

Distributed by biffo-template's scripts/shared-sync.sh. These files are held
verbatim from the template; see shared-files.json there for the list and why
this mechanism exists.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" >/dev/null 2>&1

  # The PR's file list, built here rather than inline in the --body heredoc:
  # a conditional entry only appears for a repo that actually holds it, and
  # nesting that loop inside an already-interpolated double-quoted string is
  # three levels of escaping nobody should have to read.
  body_files=$(for f in $FILES; do printf -- '- `%s`\n' "$f"; done)
  if [ -n "$CONDITIONAL" ]; then
    body_files="$body_files
$(printf '%s\n' "$CONDITIONAL" | while IFS="$TAB" read -r t s; do
      [ -n "$t" ] || continue
      [ -f "$wt/$t" ] || continue
      printf -- '- `%s` (kept in step only where it already exists; canonical copy is `%s`)\n' "$t" "$s"
    done)"
  fi
  if [ -n "$FROM_SKELETON" ]; then
    _skel=$(skeleton_for "$wt")
    body_files="$body_files
$(for _entry in $FROM_SKELETON; do
      _t=${_entry%%=*}
      _m=${_entry#*=}
      # Only what this PR actually carries: a `seed` entry the repo already held
      # was not written, and listing it would claim a change that is not in the
      # diff.
      # Against origin/<base>, not `--cached`: the commit has already been made
      # by the time this runs, so the index is clean.
      git -C "$wt" diff --name-only "origin/$base" HEAD -- "$_t" | grep -q . || continue
      case "$_m" in
        sync) printf -- '- `%s` (kept in step; canonical copy is `_skeletons/%s/%s`)\n' "$_t" "$_skel" "$_t" ;;
        *) printf -- '- `%s` (seeded from `_skeletons/%s/%s`; yours from now on, never overwritten again)\n' "$_t" "$_skel" "$_t" ;;
      esac
    done)"
  fi

  # --force-with-lease: this branch is regenerated from origin/<base> on every
  # run, so a previous sync's branch is legitimately replaced -- but the lease
  # still refuses if someone else has pushed to it.
  #
  # The output is CAPTURED and classified rather than discarded. The first
  # version printed "PUSH REFUSED (run the gate there and look)" for every
  # failure, and the first real cause was a plain non-fast-forward against a
  # previous run's branch. The gate was green in that repo. A diagnostic that
  # names the wrong cause sends you to read a passing log, which is the same
  # class of defect as everything else this gate exists to catch.
  push_out=$(git -C "$wt" push --force-with-lease -u origin HEAD 2>&1)
  push_rc=$?
  if [ "$push_rc" -ne 0 ]; then
    # ORDER IS LOAD-BEARING, and the previous order named the wrong cause (#943).
    #
    # git's own rejection reason is a statement about why the push failed; hook
    # output is only evidence about the hook. So the git-level rejections are
    # matched FIRST.
    #
    # "verify ran NOTHING" used to be matched before them — and `verify.sh` prints
    # that line and exits 0 in a repo with no CI, so it appears in the output of
    # every NO-CI push whether it succeeded or not. Any failure in such a repo was
    # therefore reported as "GATE REFUSED THE PUSH". Today that sent two repos'
    # diagnosis to a gate that had exited 0, while the real cause — a stale lease —
    # went unnamed. This is the second time this classifier has named the wrong
    # cause; the comment above it records the first.
    case "$push_out" in
      *"stale info"*)
        printf '%-26s \033[31mstale lease\033[0m - run `git fetch --prune` in that clone\n' "$label" ;;
      *"non-fast-forward"*|*"fetch first"*)
        printf '%-26s \033[31mbranch diverged\033[0m - someone else pushed to chore/sync-shared\n' "$label" ;;
      *"verify failed"*|*"verify ran NOTHING"*)
        printf '%-26s \033[31mGATE REFUSED THE PUSH\033[0m - run `sh scripts/biffo.sh verify` there\n' "$label" ;;
      *)
        printf '%-26s \033[31mpush failed\033[0m: %s\n' "$label" "$(echo "$push_out" | tail -1)" ;;
    esac
    return 1
  fi
  url=$(gh pr create --repo "$slug" --base "$base" --head chore/sync-shared \
    --title "chore(shared): sync template-shared files" \
    --body "Distributed by \`biffo-template\`'s \`scripts/shared-sync.sh\`.

Sibling and plugin repos are separate repositories with no \`core-manifest.json\`, so \`biffo core upgrade\` cannot reach them. The documented channel was \"vendor into the skeleton plus a one-time manual copy-in\", which only ever helped repos created afterwards — and is why this repo was running a local gate two versions old.

Files synced verbatim from the template (see \`shared-files.json\` there):

$body_files

Run \`sh scripts/gate-coverage.sh\` after merging to see this repo's gate measured against its own CI.

🤖 Generated with [Claude Code](https://claude.com/claude-code)" 2>&1 | tail -1)
  printf '%-26s %s\n' "$label" "$url"
  return 0
}

# The list of repos this run will touch, one `label<TAB>dir<TAB>slug<TAB>base`
# per line. Written in the survey pass and read twice afterwards, so both phases
# work from the same set: a rehearsal that proved a different list of repos than
# the one that ships is worth nothing.
TARGETS=$(mktemp)
VERDICTS=$(mktemp)
trap 'rm -f "$TARGETS" "$VERDICTS"; wt_log_run_end' EXIT

printf '\nshared-file sync - template -> repos core upgrade cannot reach\n\n'
for d in "$ESTATE"/*/; do
  d="${d%/}"
  label=$(basename "$d")
  [ -e "$d/.git" ] || continue
  # The template is the source, not a target. It matched only because it carries
  # scripts/verify.sh, and comparing it to itself through origin/<base> reported
  # it as missing every file whenever its own dev was ahead of the checkout.
  #
  # Compare REPOSITORIES, not working-tree paths. `[ "$d" = "$TEMPLATE_ROOT" ]`
  # held only when this script was run from the primary checkout -- and AGENTS.md
  # section 1 mandates that all work happens in a worktree, where TEMPLATE_ROOT
  # is `.worktrees/<name>` and the primary checkout beside it looks like just
  # another satellite carrying scripts/verify.sh. It has no biffo.core.json and
  # no sibling/plugin marker, so nothing else excluded it either.
  #
  # It never fired because a primary checkout is normally byte-identical to
  # origin/dev, so `diff_files` reported `current` and skipped it. It fires the
  # moment the candidate files differ from origin/dev -- which is the only
  # situation this script is ever run in while iterating on a shared file. The
  # first `--rehearse` from a worktree would have staged the template as a
  # target of its own distribution and opened a sync PR against its own dev.
  [ "$(repo_dir "$d")" = "$TEMPLATE_REPO" ] && continue
  [ -n "$ONLY" ] && [ "$label" != "$ONLY" ] && continue
  applies "$d" || continue
  delta=$(diff_files "$d")
  case "$delta" in
    "$UNFETCHABLE"*)
      # Not drift. This clone cannot see its own remote, so anything said about
      # its files would be a statement about a frozen ref.
      printf '%-26s \033[31mcannot fetch\033[0m - %s\n' "$label" "${delta#*	}"
      printf '%-26s   this clone cannot reach its base branch; fix the clone at %s\n' '' "$d"
      failed=$((failed + 1))
      continue
      ;;
  esac
  if [ -z "$delta" ]; then
    current=$((current + 1))
    printf '%-26s \033[32mcurrent\033[0m\n' "$label"
    continue
  fi
  drifted=$((drifted + 1))
  if [ -n "$CHECK" ]; then
    printf '%-26s \033[31mDRIFTED\033[0m%s\n' "$label" "$delta"
    continue
  fi
  slug=$(repo_slug "$d")
  base=$(gh repo view "$slug" --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null)
  if [ -z "$base" ]; then
    printf '%-26s \033[31mcannot resolve default branch\033[0m\n' "$label"
    failed=$((failed + 1))
    continue
  fi
  printf '%s\t%s\t%s\t%s\n' "$label" "$d" "$slug" "$base" >> "$TARGETS"
  printf '%-26s \033[33mdrifted\033[0m%s\n' "$label" "$delta"
done

# `current + drifted + failed` is every repo the loop above actually looked
# at -- a repo it excluded (no `.git`, the template itself, `--repo` naming
# someone else, `applies()` saying no) never touches any of the three. All
# three at zero therefore means the survey read NOTHING, which is
# indistinguishable from "0 drifted" downstream: `--check` would print
# "0 current, 0 drifted" and exit 0, and the default path would fall straight
# through the empty-$TARGETS branch below and exit 0 too -- a clean-looking
# report earned by never having looked at a single repo. That is the exact
# shape #1291 named for the dependency audits ("this audit checked nothing.
# That is a configuration error, not a pass.") and #1295's own symptom: a
# rehearsal logging `run-start` then `run-end` with no repos staged in
# between, because it never got past this point. A genuinely quiet estate
# (every repo present, applicable, and current) still has `current` > 0, so
# this cannot fire on a real clean day -- only on an empty or
# nothing-applies `--estate`.
if [ "$((current + drifted + failed))" -eq 0 ]; then
  echo "surveyed zero repos under --estate $ESTATE -- refusing to report a clean run against nothing" >&2
  exit 2
fi

if [ -n "$CHECK" ]; then
  printf '\n%s current, %s drifted\n' "$current" "$drifted"

  # `mustBeUniform`: the baselined ratchet (#1108). Report EVERY entry every
  # run, passing or not, so the debt stays visible even on a green morning --
  # `scripts/protection-audit.sh` makes the case at length that a guard red
  # every day trains people to stop reading it, and the drift check above feeds
  # exactly that daily dashboard (scripts/practices-daily.sh line ~355).
  #
  # Verdicts are written to a file rather than tracked in a shell variable
  # because the `while read` below is on the right of a pipe and therefore runs
  # in a subshell -- the same reason $VERDICTS exists further down for the
  # rehearsal loop. `uniform_worsened` is read back OUTSIDE that subshell.
  uniform_worsened=0
  if [ -n "$UNIFORM" ]; then
    printf '\nmustBeUniform -- baselined ratchet, asserts without writing (shared-files.json)\n\n'
    repos=$(applicable_repo_list)
    uverdicts=$(mktemp)
    printf '%s\n' "$UNIFORM" | while IFS="$TAB" read -r path baseline; do
      [ -n "$path" ] || continue
      blobs=$(mktemp)
      printf '%s\n' "$repos" | while IFS="$TAB" read -r label d base; do
        [ -n "$d" ] || continue
        # The blob SHA at this path in this repo's base branch IS its content
        # identity -- two repos share a SHA iff their bytes are identical, so
        # counting distinct SHAs across holders is exactly counting variants,
        # with no file ever read into this shell. A repo with no entry here
        # simply never holds the path; that is what `files` is for, not this.
        blob=$(git -C "$d" rev-parse -q --verify "origin/$base:$path" 2>/dev/null)
        [ -n "$blob" ] && echo "$blob"
      done > "$blobs"
      holders=$(wc -l < "$blobs" | tr -d ' ')
      variants=$(sort -u "$blobs" | wc -l | tr -d ' ')
      rm -f "$blobs"

      # A path held by fewer than two repos has nothing to be uniform ACROSS --
      # reporting a verdict on it would be noise, not a measurement.
      if [ "$holders" -lt 2 ]; then
        printf '  %-12s %-42s only %s holder(s) -- need >=2 to be meaningful\n' \
          'skipped' "$path" "$holders"
        printf 'skipped\n' >> "$uverdicts"
        continue
      fi

      if [ "$variants" -gt "$baseline" ]; then
        printf '  \033[31m%-12s\033[0m %-42s %s variants across %s repos (baseline %s)\n' \
          'WORSENED' "$path" "$variants" "$holders" "$baseline"
        printf 'WORSENED\n' >> "$uverdicts"
      elif [ "$variants" -eq 1 ]; then
        # Fully converged. Called out on its own regardless of what the
        # baseline says -- a ratchet that never tightens stops meaning
        # anything, so this is also where a >1 baseline gets told to drop.
        if [ "$baseline" -eq 1 ]; then
          printf '  %-12s %-42s uniform across %s repos\n' 'uniform' "$path" "$holders"
        else
          printf '  %-12s %-42s uniform across %s repos (baseline %s -- lower it to 1)\n' \
            'uniform' "$path" "$holders" "$baseline"
        fi
        printf 'uniform\n' >> "$uverdicts"
      elif [ "$variants" -lt "$baseline" ]; then
        printf '  %-12s %-42s %s variants across %s repos (baseline %s -- lower it)\n' \
          'IMPROVED' "$path" "$variants" "$holders" "$baseline"
        printf 'IMPROVED\n' >> "$uverdicts"
      else
        printf '  %-12s %-42s %s variants across %s repos (baseline %s)\n' \
          'at baseline' "$path" "$variants" "$holders" "$baseline"
        printf 'at-baseline\n' >> "$uverdicts"
      fi
    done
    grep -q '^WORSENED$' "$uverdicts" 2>/dev/null && uniform_worsened=1
    rm -f "$uverdicts"
  fi

  # A repo whose clone could not be fetched was neither current nor drifted --
  # it was unreadable, and exiting 0 over it is the fail-open this check exists
  # to remove one level down. `--check` feeds the daily dashboard, where a 0
  # renders as OK; a repo nobody could read must not be part of that OK.
  if [ "${failed:-0}" -gt 0 ]; then
    printf '\n\033[31m%s repo(s) could not be read.\033[0m Their drift is unknown, not clean.\n\n' \
      "$failed"
    exit 1
  fi

  if [ "$drifted" -gt 0 ] || [ "$uniform_worsened" -gt 0 ]; then
    if [ "$drifted" -gt 0 ]; then
      printf '\n\033[31mShared files have drifted.\033[0m Run without --check to open sync PRs.\n'
    fi
    if [ "$uniform_worsened" -gt 0 ]; then
      printf '\n\033[31mA mustBeUniform path exceeded its baseline.\033[0m That is a NEW divergence,\n'
      printf 'not the pre-existing residue the baseline tolerates -- reconcile the copies by\n'
      printf 'hand (see AGENTS.md section 9, "Reconcile before you distribute") rather than\n'
      printf 'raising the baseline to match.\n'
    fi
    printf '\n'
    exit 1
  fi
  printf '\n'
  exit 0
fi

if [ ! -s "$TARGETS" ]; then
  printf '\n%s current, %s drifted\n\n' "$current" "$drifted"
  [ "${failed:-0}" -gt 0 ] && exit 1
  exit 0
fi

# ---- The round gate ----------------------------------------------------------
#
# A round is not free: it opens one PR per drifted repo and nothing auto-merges
# them, so every round a human starts is ~12 more merges somebody has to land.
# On 2026-08-03 seven ad-hoc rounds produced 81 merges across 12 repos, 69 of
# them avoidable -- the estate's ENTIRE avoidable-merge count for the day, from
# this one script. Batching to one scheduled round takes that to ~12.
#
# So the default becomes "wait for the round", and shipping immediately becomes
# a thing you say out loud. "People will just stop running it by hand once a
# schedule exists" is behavioural, and this repo's own thesis -- argued at
# length in docs/guides/development-practices.md -- is that documented is not
# prevented.
#
# It is deliberately fail-OPEN on the schedule's absence, which is the opposite
# posture to most gates here and is the right one. If the daily round is not
# actually running, gating the manual path would leave drift undistributed
# forever while printing a confident message about a round that never comes --
# strictly worse than no gate. So the marker is written by the RUN, not by the
# install, and it ages out: a schedule that dies stops gating within 48 hours
# and the manual path reopens by itself.
_scheduled_round_is_live() {
  # Beside the ESTATE, not in `$HOME`. The question this answers is "has a
  # scheduled round run for THIS estate", so the estate is what it should be
  # keyed to — and a `$HOME`-global path made the answer depend on the machine
  # rather than the subject.
  #
  # That is not theoretical: the first version defaulted to
  # `$HOME/.shared-sync-daily.last`, and the moment a real round wrote one, seven
  # fixture tests began failing on this workstation — they drive throwaway
  # estates in `/tmp` and never set the variable, so they read the developer's
  # own marker and the gate stopped their rounds. CI has no marker, so it stayed
  # green: a local-gate/CI divergence in the direction that is hardest to
  # believe, where the suite passes in the place nobody is watching and fails in
  # the place somebody is.
  #
  # Keying it to `$ESTATE` fixes both at once and needs no test to know the gate
  # exists: a fixture estate is a fresh temp directory, so it has no marker, so
  # the gate is inert there by construction rather than by an opt-out somebody
  # has to remember at each call site.
  _marker="${SHARED_SYNC_MARKER:-$ESTATE/.shared-sync-daily.last}"
  [ -f "$_marker" ] || return 1
  _now_s=$(date +%s)
  _marker_s=$(date -r "$_marker" +%s 2>/dev/null || echo 0)
  [ "$((_now_s - _marker_s))" -lt 172800 ]
}

if [ -z "$SCHEDULED" ] && [ -z "$NOW" ]; then
  if _scheduled_round_is_live; then
    printf '\n%s current, %s drifted -- \033[33mnot shipping\033[0m\n\n' "$current" "$drifted"
    printf 'A scheduled round runs daily (scripts/shared-sync-daily.sh, last run %s).\n' \
      "$(cat "${SHARED_SYNC_MARKER:-$ESTATE/.shared-sync-daily.last}" 2>/dev/null || echo unknown)"
    printf 'Starting another one by hand costs %s more PRs that somebody has to merge,\n' "$drifted"
    printf 'and that cost was 69 of the estate'"'"'s 69 avoidable merges on 2026-08-03.\n\n'
    printf '  wait      the next round distributes this automatically\n'
    printf '  --now     ship immediately anyway (governance change that must not wait)\n'
    printf '  --check   report drift without opening anything\n\n'
    exit 0
  fi
  printf '\n\033[33mNo scheduled round has run in the last 48h\033[0m -- shipping this one, because\n'
  printf 'gating it would leave drift undistributed with nothing to pick it up.\n'
  printf 'Install the daily round to stop paying for ad-hoc ones; the crontab line is\n'
  printf 'in the header of scripts/shared-sync-daily.sh.\n'
fi

# ---- Phase 1: rehearse -------------------------------------------------------
#
# Every target, before any of them ships. The order matters and it is the whole
# point of the change: staging repo 7 and finding the gate broken there must not
# leave six PRs already open in repos 1-6.
if [ -n "$NO_REHEARSE" ]; then
  printf '\n\033[31m--no-rehearse: shipping %s repos unproven.\033[0m ' "$(wc -l < "$TARGETS" | tr -d ' ')"
  printf 'Nothing has run the gate against these candidates.\n'
else
  printf '\nrehearsing %s repos - staging the candidates and running each gate\n\n' \
    "$(wc -l < "$TARGETS" | tr -d ' ')"
  rehearsal_failures=0
  while IFS="$TAB" read -r label d slug base; do
    # Read the status IMMEDIATELY. `if ! stage_repo ...` would have collapsed
    # "could not stage" (1) and "nothing to sync" (2) into one branch, and
    # reported a repo that was already current as a staging failure.
    stage_repo "$d" "$label" "$base"
    stage_rc=$?
    if [ "$stage_rc" -eq 2 ]; then
      printf '%-26s \033[32mnothing to sync\033[0m\n' "$label"
      printf '%s%s%s%s%s\n' "$label" "$TAB" SKIP "$TAB" 'nothing to sync' >> "$VERDICTS"
      continue
    fi
    if [ "$stage_rc" -ne 0 ]; then
      printf '%-26s \033[31mCANNOT STAGE\033[0m - fetch or worktree failed\n' "$label"
      printf '%s%s%s%s%s\n' "$label" "$TAB" FAIL "$TAB" 'could not stage' >> "$VERDICTS"
      rehearsal_failures=$((rehearsal_failures + 1))
      continue
    fi
    verdict_line=$(rehearse_repo "$d/.worktrees/shared-sync")
    verdict=$(printf '%s' "$verdict_line" | cut -f1)
    detail=$(printf '%s' "$verdict_line" | cut -f2-)
    case "$verdict" in
      PASS)  printf '%-26s \033[32mPASS\033[0m  %s\n' "$label" "$detail" ;;
      NO-CI) printf '%-26s \033[90mNO-CI\033[0m %s\n' "$label" "$detail" ;;
      *)
        printf '%-26s \033[31mFAIL\033[0m  %s\n' "$label" "$detail"
        printf '%-26s       staged tree left at %s\n' '' "$d/.worktrees/shared-sync"
        rehearsal_failures=$((rehearsal_failures + 1)) ;;
    esac
    printf '%s%s%s%s%s\n' "$label" "$TAB" "$verdict" "$TAB" "$detail" >> "$VERDICTS"
  done < "$TARGETS"

  if [ "$rehearsal_failures" -gt 0 ]; then
    printf '\n\033[31mrehearsal failed in %s repo(s) - NOTHING was pushed and no PR was opened.\033[0m\n' \
      "$rehearsal_failures"
    printf 'Fix the candidate files here in the template, then run this again. Each\n'
    printf 'round that ships before it is proven costs one PR per satellite: there were\n'
    printf '84 of them on 2026-07-29, in 7 rounds, and six of those rounds carried\n'
    printf 'scripts/verify.sh alone.\n'
    printf 'The failing repos keep their staged worktree so the gate can be run there;\n'
    printf 'the clean ones were removed.\n\n'
    while IFS="$TAB" read -r label verdict detail; do
      [ "$verdict" = FAIL ] || continue
      printf '  %-24s %s\n' "$label" "$detail"
    done < "$VERDICTS"
    printf '\n'
    # Reap the worktrees of the repos that passed. They staged cleanly and are
    # not evidence of anything; leaving 11 of them behind after a refusal is the
    # orphan-worktree accumulation AGENTS.md section 1 exists to prevent.
    while IFS="$TAB" read -r label d slug base; do
      grep -q "^$label${TAB}FAIL${TAB}" "$VERDICTS" && continue
      wt_log remove-rehearsal-fail "$label" "$d/.worktrees/shared-sync"
      git -C "$d" worktree remove --force "$d/.worktrees/shared-sync" 2>/dev/null
      git -C "$d" branch -D chore/sync-shared 2>/dev/null
    done < "$TARGETS"
    exit 1
  fi
  printf '\nrehearsal clean in every repo\n'
fi

if [ -n "$REHEARSE_ONLY" ]; then
  # Staged worktrees are left in place deliberately: --rehearse answers "would
  # this land?", and the tree that answered it is the thing to go and look at.
  printf '\n--rehearse: nothing pushed, no PRs opened. Staged trees are at\n'
  printf '<repo>/.worktrees/shared-sync; re-run without --rehearse to ship.\n\n'
  exit 0
fi

# ---- Phase 2: ship -----------------------------------------------------------
printf '\nopening PRs\n\n'
while IFS="$TAB" read -r label d slug base; do
  grep -q "^$label${TAB}SKIP${TAB}" "$VERDICTS" 2>/dev/null && continue
  # --no-rehearse skips phase 1 entirely, so nothing has staged these yet.
  if [ -n "$NO_REHEARSE" ]; then
    stage_repo "$d" "$label" "$base"
    case $? in
      2) printf '%-26s \033[32mnothing to sync\033[0m\n' "$label"; continue ;;
      1) printf '%-26s \033[31mCANNOT STAGE\033[0m\n' "$label"; failed=$((failed + 1)); continue ;;
    esac
  fi
  if ship_repo "$d" "$label" "$slug" "$base"; then
    synced=$((synced + 1))
  else
    failed=$((failed + 1))
  fi
done < "$TARGETS"

printf '\n%s current, %s drifted, %s PR(s) opened' "$current" "$drifted" "$synced"
[ "${failed:-0}" -gt 0 ] && printf ', \033[31m%s failed\033[0m' "$failed"
printf '\n\n'
[ "${failed:-0}" -gt 0 ] && exit 1
exit 0
