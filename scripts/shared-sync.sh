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
# Usage:
#   sh scripts/shared-sync.sh --check --estate ~/code   # report drift, exit 1 if any
#   sh scripts/shared-sync.sh --estate ~/code           # open a PR per drifted repo
#   sh scripts/shared-sync.sh --estate ~/code --repo tabsii-crm

set -uo pipefail

TEMPLATE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$TEMPLATE_ROOT/shared-files.json"
[ -f "$MANIFEST" ] || { echo "no shared-files.json beside $0" >&2; exit 2; }

CHECK=""
ESTATE=""
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --estate) ESTATE="$2"; shift 2 ;;
    --repo) ONLY="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$ESTATE" ] || { echo "--estate <dir> is required" >&2; exit 2; }

FILES=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).files.join('\n'))")
MARKERS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).appliesTo.join(' '))")

drifted=0
synced=0
current=0

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
  for f in $FILES; do
    if [ ! -f "$d/$f" ]; then
      out="$out $f(missing)"
    elif ! cmp -s "$TEMPLATE_ROOT/$f" "$d/$f"; then
      out="$out $f"
    fi
  done
  echo "$out"
}

sync_repo() {
  d="$1"
  label="$2"
  slug=$(git -C "$d" remote get-url origin | sed -E 's#.*[:/]([^/]+/[^/]+)$#\1#; s#\.git$##')
  base=$(gh repo view "$slug" --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null)
  [ -n "$base" ] || { printf '%-26s \033[31mcannot resolve default branch\033[0m\n' "$label"; return 1; }

  git -C "$d" fetch origin --quiet || return 1
  wt="$d/.worktrees/shared-sync"
  git -C "$d" worktree remove --force "$wt" 2>/dev/null
  git -C "$d" branch -D chore/sync-shared 2>/dev/null
  git -C "$d" worktree add -q "$wt" -b chore/sync-shared "origin/$base" || return 1

  for f in $FILES; do
    mkdir -p "$wt/$(dirname "$f")"
    cp "$TEMPLATE_ROOT/$f" "$wt/$f"
    chmod +x "$wt/$f" 2>/dev/null
  done

  # Install the JS/Python deps the gate will now check, or its own pre-push
  # correctly refuses this push -- and reaching for BIFFO_SKIP_VERIFY to ship a
  # gate would be the counter-metric H4 pre-registered as refuting itself.
  for p in $( (cd "$wt" && sh scripts/verify.sh --list 2>/dev/null) | grep -oE '\-\-dir(ectory)? \./[A-Za-z0-9_./-]+' | awk '{print $2}' | sort -u); do
    (cd "$wt/$p" 2>/dev/null && { pnpm install --frozen-lockfile >/dev/null 2>&1 ||
      pnpm install --frozen-lockfile --ignore-workspace >/dev/null 2>&1 ||
      uv sync --all-groups >/dev/null 2>&1; }) || true
  done

  git -C "$wt" add -A
  if git -C "$wt" diff --cached --quiet; then
    git -C "$d" worktree remove --force "$wt" 2>/dev/null
    printf '%-26s \033[32mnothing to sync\033[0m\n' "$label"
    return 0
  fi
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

printf '\nshared-file sync - template -> repos core upgrade cannot reach\n\n'
for d in "$ESTATE"/*/; do
  d="${d%/}"
  label=$(basename "$d")
  [ -e "$d/.git" ] || continue
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
  else
    sync_repo "$d" "$label" && synced=$((synced + 1))
  fi
done

printf '\n%s current, %s drifted\n' "$current" "$drifted"
if [ -n "$CHECK" ] && [ "$drifted" -gt 0 ]; then
  printf '\033[31mShared files have drifted.\033[0m Run without --check to open sync PRs.\n\n'
  exit 1
fi
printf '\n'
