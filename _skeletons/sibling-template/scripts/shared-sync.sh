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

set -uo pipefail

TEMPLATE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$TEMPLATE_ROOT/shared-files.json"
[ -f "$MANIFEST" ] || { echo "no shared-files.json beside $0" >&2; exit 2; }

CHECK=""
ESTATE=""
ONLY=""
REHEARSE_ONLY=""
NO_REHEARSE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --rehearse) REHEARSE_ONLY=1; shift ;;
    # In the open, per AGENTS.md section 7: a gate that can be skipped silently
    # is not a gate. This prints the reason on every line it lets through, so a
    # transcript shows what was shipped unproven.
    --no-rehearse) NO_REHEARSE=1; shift ;;
    --estate) ESTATE="$2"; shift 2 ;;
    --repo) ONLY="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$ESTATE" ] || { echo "--estate <dir> is required" >&2; exit 2; }
[ -n "$REHEARSE_ONLY" ] && [ -n "$NO_REHEARSE" ] && {
  echo "--rehearse and --no-rehearse are opposites" >&2; exit 2; }

FILES=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).files.join('\n'))")
MARKERS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).appliesTo.join(' '))")

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
  # Also: any repo already carrying the gate. The runner repos have neither
  # marker but did receive verify.sh, and a mechanism that distributes a file
  # once and then stops tracking it is the drift this script exists to end --
  # it would have recreated the exact hole in the exact repos nobody watches.
  [ -f "$1/scripts/verify.sh" ] && return 0
  return 1
}

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
  git -C "$d" fetch origin --quiet 2>/dev/null
  # `dev` first, per AGENTS.md section 2: it is the integration branch in every
  # Biffo repo. origin/HEAD is NOT a substitute -- it points at `main` in
  # several clones, and `main` is a stale release branch that legitimately does
  # not carry these files, so resolving through it reported three repos as
  # missing everything.
  if git -C "$d" rev-parse --verify --quiet origin/dev >/dev/null 2>&1; then
    base=dev
  else
    base=$(git -C "$d" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
    [ -n "$base" ] || base=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)
  fi
  for f in $FILES; do
    remote=$(git -C "$d" show "origin/$base:$f" 2>/dev/null)
    if [ -z "$remote" ]; then
      out="$out $f(missing)"
    elif [ "$remote" != "$(cat "$TEMPLATE_ROOT/$f")" ]; then
      out="$out $f"
    fi
  done
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

# Phase 1: put the candidate files in place and make the repo ready to run its
# own gate against them. Deliberately stops short of committing anything -- a
# staged worktree is a question ("would this land?"), and until phase 2 it has no
# commit, no push and no PR.
stage_repo() {
  d="$1"
  label="$2"
  base="$3"

  git -C "$d" fetch origin --quiet || return 1
  wt="$d/.worktrees/shared-sync"
  git -C "$d" worktree remove --force "$wt" 2>/dev/null
  # `branch -D` reports on STDOUT, so a quiet run printed "Deleted branch
  # chore/sync-shared" in the middle of the rehearsal table.
  git -C "$d" branch -D chore/sync-shared >/dev/null 2>&1
  git -C "$d" worktree add -q "$wt" -b chore/sync-shared "origin/$base" || return 1

  for f in $FILES; do
    mkdir -p "$wt/$(dirname "$f")"
    cp "$TEMPLATE_ROOT/$f" "$wt/$f"
    chmod +x "$wt/$f" 2>/dev/null
  done

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
  for p in $( (cd "$wt" && sh scripts/verify.sh --list 2>/dev/null) | grep -oE '\-\-dir(ectory)? \./[A-Za-z0-9_./-]+' | awk '{print $2}' | sort -u); do
    (cd "$wt/$p" 2>/dev/null && { pnpm install --frozen-lockfile >/dev/null 2>&1 ||
      pnpm install --frozen-lockfile --ignore-workspace >/dev/null 2>&1 ||
      uv sync --all-groups >/dev/null 2>&1; }) || true
  done

  git -C "$wt" add -A
  if git -C "$wt" diff --cached --quiet; then
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
  # (`exec sh scripts/verify.sh`), and /bin/sh is dash on every machine in this
  # estate. A gate proven under one shell and run under another is not the same
  # gate -- `js-dependency-audit.sh` reported INCONCLUSIVE on every invocation
  # while exiting 0 for exactly that reason, because dash's `echo` interprets
  # backslash escapes and bash's does not (#883).
  _out=$( (cd "$wt" && sh scripts/verify.sh 2>&1) )
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
  _cov=$( (cd "$wt" && sh scripts/gate-coverage.sh 2>&1) |
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
ship_repo() {
  d="$1"
  label="$2"
  slug="$3"
  base="$4"
  wt="$d/.worktrees/shared-sync"

  git -C "$wt" -c commit.gpgsign=false commit -q --no-verify -m "chore(shared): sync template-shared files

Distributed by biffo-template's scripts/shared-sync.sh. These files are held
verbatim from the template; see shared-files.json there for the list and why
this mechanism exists.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" >/dev/null 2>&1

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
    case "$push_out" in
      *"verify failed"*|*"verify ran NOTHING"*)
        printf '%-26s \033[31mGATE REFUSED THE PUSH\033[0m - run scripts/verify.sh there\n' "$label" ;;
      *"stale info"*|*"non-fast-forward"*)
        printf '%-26s \033[31mbranch diverged\033[0m - someone else pushed to chore/sync-shared\n' "$label" ;;
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

$(for f in $FILES; do echo "- \`$f\`"; done)

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
trap 'rm -f "$TARGETS" "$VERDICTS"' EXIT

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

if [ -n "$CHECK" ]; then
  printf '\n%s current, %s drifted\n' "$current" "$drifted"
  if [ "$drifted" -gt 0 ]; then
    printf '\033[31mShared files have drifted.\033[0m Run without --check to open sync PRs.\n\n'
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
