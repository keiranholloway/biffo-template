#!/usr/bin/env bash
#
# Is a git hook actually going to execute here?
#
# ## Why this exists
#
# A configured hook that does not run is worse than no hook, because it is
# assumed to be protecting you. On 2026-07-29 the estate was in exactly that
# state: `core.hooksPath` pointed at `.husky/_`, a **gitignored** directory
# created only by `prepare: husky` on `pnpm install` — and git resolves that
# relative path against *each worktree's* root. Every fresh worktree therefore
# had no hooks, and git said nothing: no warning, no error, no output.
#
# AGENTS.md §1 mandates a fresh worktree per unit of work, so the required
# workflow disarmed its own gates. 6 of 32 working trees were armed. The pre-push
# pyright, the pre-commit lint-staged and commitlint had all been silently
# skipped in the other 26 for as long as anyone had been using worktrees.
#
# Nothing detected it because nothing looked. This is the thing that looks.
#
# ## Verdicts
#
#   ARMED     git will execute a hook here.
#   DEAD      core.hooksPath is set and its target is missing or carries no
#             hooks. Git skips silently. **This is the state that lies to you**,
#             and the only one that makes this script exit non-zero.
#   NO-HOOKS  no hooks configured at all. Honest, and visible in this report.
#
# Usage:
#   sh scripts/hook-audit.sh                 # this repo and its worktrees
#   sh scripts/hook-audit.sh --estate ~/code # every repo under a directory
#   sh scripts/hook-audit.sh --quiet         # verdict counts only

set -uo pipefail

ESTATE=""
QUIET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --estate) ESTATE="$2"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

armed=0
dead=0
nohooks=0
dead_list=""

# The three hooks this standard cares about. A hooksPath directory containing
# none of them is not armed for our purposes even if it holds something else.
WANTED='^(pre-commit|pre-push|commit-msg)$'

report() {
  tree="$1"
  label="$2"
  hp=$(git -C "$tree" config core.hooksPath 2>/dev/null)

  if [ -z "$hp" ]; then
    # The default hooks directory is in the **common** git dir, which linked
    # worktrees share. Reading "$tree/.git/hooks" is wrong for exactly the trees
    # this audit exists to check: in a linked worktree `.git` is a *file*
    # containing a gitdir pointer, so that path does not exist and every armed
    # worktree was about to be reported NO-HOOKS. Ask git where it actually is.
    #
    # Git ships .sample files there that never execute, so counting the
    # directory as armed merely for being non-empty would be exactly the false
    # comfort this script exists to remove.
    common=$(git -C "$tree" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
    real=$(ls "${common:-$tree/.git}/hooks" 2>/dev/null | grep -vc '\.sample$' || true)
    if [ "${real:-0}" -gt 0 ]; then
      armed=$((armed + 1))
      [ -n "$QUIET" ] || printf '%-56s %-14s \033[32mARMED\033[0m    %s\n' "$label" "(default)" "$real hook(s) in .git/hooks"
    else
      nohooks=$((nohooks + 1))
      [ -n "$QUIET" ] || printf '%-56s %-14s \033[33mNO-HOOKS\033[0m %s\n' "$label" "(default)" "no hooks configured"
    fi
    return
  fi

  # Relative hooksPath resolves against the working tree root — the whole bug.
  case "$hp" in
    /*) dir="$hp" ;;
    *) dir="$tree/$hp" ;;
  esac

  present=$(ls "$dir" 2>/dev/null | grep -E "$WANTED" | tr '\n' ',' || true)
  if [ -z "$present" ]; then
    dead=$((dead + 1))
    dead_list="$dead_list  $label ($hp)
"
    [ -n "$QUIET" ] || printf '%-56s %-14s \033[31mDEAD\033[0m     %s\n' "$label" "$hp" "$hp missing or holds no hooks — git skips ALL hooks silently"
  else
    armed=$((armed + 1))
    [ -n "$QUIET" ] || printf '%-56s %-14s \033[32mARMED\033[0m    %s\n' "$label" "$hp" "${present%,}"
  fi
}

walk_repo() {
  root="${1%/}"
  name="$2"
  # Every working tree, not just the primary — the primary is usually the one
  # that IS armed, which is how this went unnoticed for so long.
  git -C "$root" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | while read -r t; do
    [ -d "$t" ] || continue
    if [ "$t" = "$root" ]; then echo "$t|$name"; else echo "$t|$name${t#$root}"; fi
  done
}

[ -n "$QUIET" ] || printf '%-56s %-14s %-8s %s\n' "WORKING TREE" "hooksPath" "VERDICT" "detail"

if [ -n "$ESTATE" ]; then
  targets=$(for d in "$ESTATE"/*/; do
    [ -e "$d/.git" ] || continue
    walk_repo "$d" "$(basename "${d%/}")"
  done)
else
  root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not a git repo" >&2; exit 2; }
  # From inside a worktree, --show-toplevel gives the worktree; walk from the
  # common repo so sibling worktrees are audited too.
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  root=$(dirname "$common")
  targets=$(walk_repo "$root" "$(basename "$root")")
fi

while IFS='|' read -r tree label; do
  [ -n "$tree" ] || continue
  report "$tree" "$label"
done <<EOF
$targets
EOF

total=$((armed + dead + nohooks))
printf '\n%s working trees — \033[32m%s armed\033[0m, \033[31m%s dead\033[0m, %s without hooks' "$total" "$armed" "$dead" "$nohooks"
[ "$total" -gt 0 ] && printf ' (%s%% armed)' "$((100 * armed / total))"
printf '\n'

if [ "$dead" -gt 0 ]; then
  printf '\n\033[31mDEAD working trees — hooks are configured here and are NOT running:\033[0m\n%s' "$dead_list"
  printf 'Every commit and push made in these is unguarded, and nothing says so.\n'
  printf 'Fix: run `pnpm install` there, or move the repo to tracked .githooks/.\n'
  exit 1
fi
exit 0
