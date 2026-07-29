#!/usr/bin/env bash
#
# Does each repo's local gate actually cover that repo's CI?
#
# ## Why this exists
#
# `hook-audit.sh` answers "will a hook execute here". That question hit 100%
# across the estate on 2026-07-29 while eight repos had a gate that checked
# **nothing they were written in** — `tabsii-crm` ran one check, terraform-fmt,
# on a 700-line TypeScript-and-Python change, and printed `verify passed`.
#
# Arming was a proxy and it was reported as the outcome. This is the metric that
# can actually fail: for every repo, the set of check *kinds* its CI runs, minus
# the ones deliberately excluded, must be covered by the set its gate runs.
#
# The parity test in `cli/src/lib/verify-parity.test.ts` compares the gate to CI
# too — but it runs only in `biffo-template`, the single repo with both a root
# `package.json` and a root `pyproject.toml`, i.e. the one place the root-only
# assumption held. It validated the gate where the gate was already correct.
# This runs everywhere, which is the whole point.
#
# Usage:
#   sh scripts/gate-coverage.sh                 # this repo
#   sh scripts/gate-coverage.sh --estate ~/code # every repo under a directory
#
# Exits non-zero if any repo's gate misses a check kind its CI runs.

set -uo pipefail

ESTATE=""
[ "${1:-}" = "--estate" ] && ESTATE="${2:-}"

# Deliberately excluded from local gates, with the reason. Kept in step with
# verify-parity.test.ts. An exclusion here must describe what the CI step
# actually DOES, not what it was assumed to do — the bandit exclusion claimed
# "the finding gate is the upload step" when `bandit -ll` exits non-zero and it
# is the run step that fails (#855).
EXCLUDED_KINDS="pytest build audit gitleaks codeql e2e playwright release-subject ownership"

# Reduce a command to the KIND of check it is. Comparing raw command strings is
# hopeless across repos — CI uses `working-directory:` where the gate uses
# `--dir` — and what matters is "does a lint run locally where CI runs a lint".
kind_of() {
  case "$1" in
    *"run lint"*) echo lint ;;
    *"run typecheck"*) echo typecheck ;;
    *"run format:check"*) echo format ;;
    *"run e2e"*) echo e2e ;;
    *"run build"*|*"portal build"*) echo build ;;
    *"run test"*) echo test ;;
    *"ruff check"*) echo ruff-check ;;
    *"ruff format"*) echo ruff-format ;;
    *pyright*) echo pyright ;;
    *pytest*) echo pytest ;;
    *bandit*) echo bandit ;;
    *"terraform fmt"*) echo terraform-fmt ;;
    *playwright*) echo playwright ;;
    *"dependency-audit"*|*"pnpm audit"*|*"pip-audit"*) echo audit ;;
    *gitleaks*) echo gitleaks ;;
    *"check release-subject"*) echo release-subject ;;
    *"check ownership"*) echo ownership ;;
    *"check plugin-terraform"*) echo plugin-terraform ;;
    *"check plugin-collisions"*) echo plugin-collisions ;;
    *install*|*"uv sync"*) echo "" ;;
    *) echo "" ;;
  esac
}

kinds_from_ci() {
  d="$1"
  f="$d/.github/workflows/ci.yml"
  [ -f "$f" ] || return 0
  grep -hoE "run: (pnpm|uv|terraform|sh scripts/)[^\"']*" "$f" 2>/dev/null |
    sed 's/^run: //' | while read -r cmd; do kind_of "$cmd"; done | grep -v '^$' | sort -u
}

kinds_from_gate() {
  d="$1"
  [ -f "$d/scripts/verify.sh" ] || return 0
  (cd "$d" && sh scripts/verify.sh --list 2>/dev/null) |
    while read -r cmd; do kind_of "$cmd"; done | grep -v '^$' | sort -u
}

failed=0
report() {
  d="$1"
  label="$2"
  if [ ! -f "$d/scripts/verify.sh" ]; then
    printf '%-26s \033[33mNO GATE\033[0m\n' "$label"
    return
  fi
  ci=$(kinds_from_ci "$d")
  gate=$(kinds_from_gate "$d")
  if [ -z "$ci" ]; then
    printf '%-26s \033[90mno CI to mirror\033[0m (gate runs %s)\n' "$label" "$(echo "$gate" | grep -cv '^$')"
    return
  fi
  missing=""
  total=0
  covered=0
  for k in $ci; do
    case " $EXCLUDED_KINDS " in *" $k "*) continue ;; esac
    total=$((total + 1))
    if echo "$gate" | grep -qx "$k"; then covered=$((covered + 1)); else missing="$missing $k"; fi
  done
  if [ -n "$missing" ]; then
    failed=1
    printf '%-26s \033[31m%s/%s\033[0m  missing:%s\n' "$label" "$covered" "$total" "$missing"
  else
    printf '%-26s \033[32m%s/%s\033[0m\n' "$label" "$covered" "$total"
  fi
}

printf '\ngate coverage - CI check kinds mirrored by the local gate\n\n'
if [ -n "$ESTATE" ]; then
  for d in "$ESTATE"/*/; do
    [ -e "$d/.git" ] || continue
    report "${d%/}" "$(basename "${d%/}")"
  done
else
  root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not a git repo" >&2; exit 2; }
  report "$root" "$(basename "$root")"
fi

printf '\n'
if [ "$failed" -ne 0 ]; then
  printf '\033[31mSome gates do not cover their own CI.\033[0m A gate that misses the language a\n'
  printf 'change is written in reports `verify passed` on work it never checked.\n\n'
  exit 1
fi
printf '\033[32mEvery gate covers its own CI.\033[0m\n\n'
