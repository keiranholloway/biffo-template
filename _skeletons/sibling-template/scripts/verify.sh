#!/usr/bin/env sh
#
# Run the checks CI runs, here, before the push that would have found them.
#
# ## Why this exists
#
# Until 2026-07-29 the only local gate was a whole-project `pyright` in a
# pre-push hook -- in the three repos that had hooks at all. Everything else
# (eslint, prettier, tsc, vitest, ruff, terraform fmt, the plugin guards) ran for
# the first time on a GitHub runner, after a push, after a PR, after the merge
# race.
#
# Over the 30 days to 2026-07-29, across the twelve repos in the estate that run
# CI: 373 failed runs, and 211 of 342 failing steps (62%) were locally
# catchable -- deterministic, offline, no credentials. By kind: tests 49,
# format 53, typecheck 20, lint 16, terraform fmt 12, and the core ownership
# guard 11 -- a check already wired as a commit hook, being discovered in the
# pipeline because the hook was not running.
#
# The same file failed the same check across consecutive runs -- e.g.
# services/api/src/api/routing/crud_handlers.py failing `ruff format --check` on
# four separate runs. That is the signature of a round trip being used as the
# check: push, wait for CI, read the failure, fix, push again.
#
# ## Why it adapts instead of being tailored
#
# This one file runs in the template, in instances, in sibling apps and in
# plugin repos, whose CI check sets differ. It could have been forked per repo;
# forks drift, and a gate that has drifted from CI reports a green CI will not
# honour.
#
# So every check is conditional on the repo actually having it, and an
# inapplicable check prints `n/a` rather than being silently absent. Absence and
# inapplicability look identical in a summary that omits both, and telling them
# apart is the entire point (docs/practices/standards/local-gates.md).
#
# ## What is deliberately excluded
#
#   - pytest -- 56s in the template, more than the rest of the gate combined,
#     and it failed once there in 30 days. Opt in per repo with
#     BIFFO_VERIFY_PYTEST=1 where the suite is fast.
#   - app/portal build -- a full Next build.
#   - dependency audits, pip-audit, pnpm audit -- network.
#   - gitleaks -- scans history, not the working tree.
#
# cli/src/lib/verify-parity.test.ts fails if the template's CI grows a check
# that is neither here nor in that written exclusion list.
#
# Usage:
#   sh scripts/verify.sh          # everything applicable to this repo
#   pnpm run verify               # same
#   BIFFO_SKIP_VERIFY=1 git push  # escape hatch, for when you mean it

set -u

FAILED=""
PASSED=""
SKIPPED=""

PYTEST="${BIFFO_VERIFY_PYTEST:-}"

have_script() {
  [ -f package.json ] || return 1
  node -e "process.exit(JSON.parse(require('fs').readFileSync('package.json','utf8')).scripts?.['$1']?0:1)" 2>/dev/null
}

run_check() {
  name="$1"
  shift
  start=$(date +%s)
  if "$@" >"/tmp/biffo-verify.$$" 2>&1; then
    PASSED="$PASSED $name"
    printf '  \033[32mOK\033[0m   %-16s %ss\n' "$name" "$(($(date +%s) - start))"
  else
    FAILED="$FAILED $name"
    printf '  \033[31mFAIL\033[0m %-16s %ss\n' "$name" "$(($(date +%s) - start))"
    sed 's/^/      /' "/tmp/biffo-verify.$$" | tail -25
  fi
  rm -f "/tmp/biffo-verify.$$"
}

skip() {
  SKIPPED="$SKIPPED $1"
  printf '  \033[90m--   %-16s n/a - %s\033[0m\n' "$1" "$2"
}

printf '\nverify - the checks CI runs, before the push\n\n'

# Python first: ruff is near-instant, so the cheapest feedback on the largest
# single class of failure comes back immediately.
if [ -f pyproject.toml ]; then
  if command -v uv >/dev/null 2>&1; then
    run_check ruff-check uv run ruff check .
    run_check ruff-format uv run ruff format --check .
    run_check pyright uv run pyright
    if [ -n "$PYTEST" ]; then
      run_check pytest uv run pytest -q
    else
      skip pytest "excluded - set BIFFO_VERIFY_PYTEST=1 where the suite is fast"
    fi
  else
    skip python "uv not installed"
  fi
else
  skip python "no pyproject.toml in this repo"
fi

# Terraform, wherever this repo keeps it: modules/ in the template and
# instances, infra/ and modules/ in siblings.
if command -v terraform >/dev/null 2>&1; then
  # Scope must match this repo's CI, not exceed it. The template and instances
  # deliberately fmt-check modules/ ONLY: infra/environments/ is user-owned, and
  # a template-shipped check asserting over paths the template does not own is
  # the #325 trap -- it reds an instance on content it neither wrote nor can
  # repair. Siblings own their whole infra/ and their CI checks it, so they get
  # both. biffo.sibling.json is what tells them apart.
  tf_dirs=""
  [ -d modules ] && tf_dirs="$tf_dirs modules/"
  [ -f biffo.sibling.json ] && [ -d infra ] && tf_dirs="$tf_dirs infra/"
  if [ -n "$tf_dirs" ]; then
    # shellcheck disable=SC2086
    run_check terraform-fmt terraform fmt -check -recursive $tf_dirs
  else
    skip terraform-fmt "no terraform in this repo"
  fi
else
  skip terraform-fmt "terraform not installed"
fi

# The Biffo guards, where the dispatcher exists. Cheap, and two of them
# (ownership, plugin-terraform) were being caught in CI.
if [ -f scripts/biffo.sh ]; then
  run_check plugin-tf sh scripts/biffo.sh check plugin-terraform
  run_check plugin-names sh scripts/biffo.sh check plugin-collisions
else
  skip biffo-guards "no scripts/biffo.sh in this repo"
fi

# JS, cheapest first; `test` last because it is slowest and the most likely to
# be interrupted by an impatient reader.
if [ -f package.json ]; then
  skip build "excluded - a full app build is too slow for a push gate"
  for s in lint typecheck format:check test; do
    label=$(printf '%s' "$s" | tr -d ':')
    if have_script "$s"; then
      run_check "$label" pnpm run "$s"
    else
      skip "$label" "no \"$s\" script in package.json"
    fi
  done
else
  skip javascript "no package.json in this repo"
fi

printf '\n'
if [ -n "$FAILED" ]; then
  printf '\033[31mverify failed:\033[0m%s\n' "$FAILED"
  printf 'Fix these here - CI will find them anyway, three minutes and a merge race later.\n'
  printf 'Most format failures are one command: pnpm run format\n\n'
  exit 1
fi
printf '\033[32mverify passed\033[0m -%s\n' "$PASSED"
[ -n "$SKIPPED" ] && printf '\033[90mnot applicable here:%s\033[0m\n' "$SKIPPED"
printf '\n'
