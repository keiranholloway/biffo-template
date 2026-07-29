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
#   sh scripts/verify.sh --list   # print the checks it WOULD run, and stop
#   pnpm run verify               # same
#   BIFFO_SKIP_VERIFY=1 git push  # escape hatch, for when you mean it
#
# `--list` exists so parity with CI can be tested against what this script
# actually does, rather than against its source text. The checks are assembled
# at runtime from what the repo has, so grepping the file for `pnpm run lint`
# proves nothing -- and a parity test that can be satisfied by a comment is not
# a parity test.
#
# `--list` reports what THIS REPO requires, deliberately ignoring whether the
# tooling happens to be installed here. Parity with CI is a property of the
# repository; "can this machine run it" is a property of the machine. Conflating
# them made the parity test pass locally and fail on a CI runner that has no
# `uv` or `terraform` -- the gate-green/CI-red split this whole exercise exists
# to remove, reproduced inside its own guard.

set -u

LIST=""
[ "${1:-}" = "--list" ] && LIST=1

FAILED=""
PASSED=""
SKIPPED=""

PYTEST="${BIFFO_VERIFY_PYTEST:-}"

# Does THIS repo's CI run a check of this kind?
#
# ## Why every check is gated on this (#861)
#
# The standard has said "derived per repo from that repo's ci.yml, not decreed"
# since it was written. The gate did not do that: it ran a fixed list, and the
# list was tuned against biffo-template. Every consequence was the same shape,
# three times in one afternoon:
#
#   - terraform-fmt over infra/ where CI checks only modules/
#   - bandit over -r services where CI scans only template-owned paths
#   - bandit at all in the plugin repos, whose CI has no bandit step and where
#     the tool is not even installed
#
# A gate STRICTER than CI is not a safer gate. It blocks correct work, sends
# people to read failures CI would never raise, and is exactly what drives
# BIFFO_SKIP_VERIFY -- a counter-metric H4 pre-registered as refuting itself.
#
# With no ci.yml there is nothing to mirror, so everything applicable runs:
# best-effort beats silence in a repo that has no pipeline to disagree with.
ci_has() {
  [ -f .github/workflows/ci.yml ] || return 0
  grep -qE "$1" .github/workflows/ci.yml
}

have_script() {
  [ -f "$2/package.json" ] || return 1
  # grep rather than node: --list must work on a machine with no toolchain at
  # all, because what it reports is a property of the repo, not of the machine.
  # Deliberately NOT anchored to line start: that only matches a pretty-printed
  # package.json, and a minified one would silently report "no lint script" --
  # a skip that looks like a considered decision. A false positive here costs a
  # loud `pnpm run` failure; a false negative costs an unchecked push.
  grep -qE "\"$1\"[[:space:]]*:" "$2/package.json"
}

# Every directory holding a JS package this repo owns.
#
# A repo with a root package.json is a workspace: `turbo run lint` fans out and
# running per-package as well would double the work. A repo WITHOUT one keeps
# its JS in subdirectories -- web/ and web-admin/ in the plugin repos,
# apps/frontend/ in the siblings -- and their CI runs the same scripts there
# with `working-directory:`.
#
# ## Why this exists (#852)
#
# The gate used to check the repo root and nothing else. In the ten repos with
# no root package.json -- every plugin, every sibling, both runner repos -- it
# printed `javascript n/a - no package.json in this repo` and then
# `verify passed`, on repos whose entire frontend is JS. A 100% TypeScript
# change pushed green with zero JavaScript verification.
#
# That is worse than the missing hooks this gate was built to fix. A repo with
# no hooks makes no claim; this one claimed to have checked. And the standard
# it was written to enforce says exactly that inapplicable and absent must not
# look the same -- while reporting "not applicable" for the language the change
# was written in.
# Every directory holding a Python project this repo owns.
#
# ## Why this exists (#855)
#
# #853 fixed this for JavaScript and left Python with the identical bug. The
# check was `[ -f pyproject.toml ]` — root only. Every sibling keeps its API at
# `services/api/pyproject.toml`, so ruff, ruff-format and pyright were skipped
# entirely, and #853's own rationale applies verbatim: a change pushed green
# with zero verification of the language it was written in.
#
# Found by an agent whose 700-line TypeScript-and-Python change to tabsii-crm
# ran exactly one check — terraform-fmt — and printed `verify passed`.
py_dirs() {
  if [ -f pyproject.toml ]; then
    echo "."
    return
  fi
  find . -name pyproject.toml \
    -not -path "*/node_modules/*" -not -path "*/.venv/*" -not -path "*/dist/*" \
    -not -path "*/.worktrees/*" -not -path "*/.terraform/*" -not -path "*/vendor/*" \
    -not -path "*/site-packages/*" 2>/dev/null |
    sed 's|/pyproject.toml$||' | sort
}

js_dirs() {
  if [ -f package.json ]; then
    echo "."
    return
  fi
  # `.terraform/` is a DOWNLOAD CACHE of third-party modules, and the two runner
  # repos carry eight vendored lambda packages in it -- each declaring lint and
  # test scripts. Linting someone else's vendored code is slow, always red, and
  # not this repo's business. It is gitignored, so a fresh worktree never has
  # it and the omission was invisible until a primary checkout was audited.
  find . -name package.json \
    -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.next/*" \
    -not -path "*/.turbo/*" -not -path "*/.worktrees/*" -not -path "*/out/*" \
    -not -path "*/coverage/*" -not -path "*/.venv/*" \
    -not -path "*/.terraform/*" -not -path "*/vendor/*" 2>/dev/null |
    sed 's|/package.json$||' | sort
}

run_check() {
  name="$1"
  shift
  if [ -n "$LIST" ]; then
    echo "$*"
    return 0
  fi
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
  [ -n "$LIST" ] && return 0
  SKIPPED="$SKIPPED $1"
  printf '  \033[90m--   %-16s n/a - %s\033[0m\n' "$1" "$2"
}

[ -n "$LIST" ] || printf '\nverify - the checks CI runs, before the push\n\n'

# Python first: ruff is near-instant, so the cheapest feedback on the largest
# single class of failure comes back immediately.
PY_DIRS=$(py_dirs)
if [ -n "$PY_DIRS" ]; then
  if [ -n "$LIST" ] || command -v uv >/dev/null 2>&1; then
    for d in $PY_DIRS; do
      suffix=""
      [ "$d" != "." ] && suffix="(${d#./})"
      if [ "$d" = "." ]; then
        ci_has "ruff check" && run_check "ruff-check$suffix" uv run ruff check .
        ci_has "ruff format" && run_check "ruff-format$suffix" uv run ruff format --check .
        ci_has "pyright" && run_check "pyright$suffix" uv run pyright
        # bandit is NOT excluded: it exits non-zero on findings and it is the
        # RUN step that fails in CI, not the artefact upload. See the exclusion
        # audit in verify-parity.test.ts (#855).
        #
        # Scoped to the SAME paths CI scans, never wider. CI runs
        # `-r services/api services/_plugins` -- template-owned code only --
        # because a template-shipped check asserting over paths the template
        # does not own reds an instance on content it neither wrote nor can
        # repair (#325). Running `-r services` here found three B310s in
        # biffo-platform's user-owned services/idea-scout/ and refused a push CI
        # would have passed: the gate being stricter than CI is its own defect,
        # and it is what drives people to BIFFO_SKIP_VERIFY.
        bandit_paths=""
        [ -d services/api ] && bandit_paths="$bandit_paths services/api"
        [ -d services/_plugins ] && bandit_paths="$bandit_paths services/_plugins"
        [ -z "$bandit_paths" ] && [ -d src ] && bandit_paths="src"
        # shellcheck disable=SC2086
        [ -n "$bandit_paths" ] && ci_has "bandit" && run_check "bandit$suffix" uv run bandit -r $bandit_paths -ll -q
        if [ -n "$PYTEST" ]; then
          run_check "pytest$suffix" uv run pytest -q
        else
          skip "pytest$suffix" "excluded - set BIFFO_VERIFY_PYTEST=1 where the suite is fast"
        fi
      else
        ci_has "ruff check" && run_check "ruff-check$suffix" uv run --directory "$d" ruff check .
        ci_has "ruff format" && run_check "ruff-format$suffix" uv run --directory "$d" ruff format --check .
        ci_has "pyright" && run_check "pyright$suffix" uv run --directory "$d" pyright
        ci_has "bandit" && run_check "bandit$suffix" uv run --directory "$d" bandit -r src -ll -q
        if [ -n "$PYTEST" ]; then
          run_check "pytest$suffix" uv run --directory "$d" pytest -q
        else
          skip "pytest$suffix" "excluded - set BIFFO_VERIFY_PYTEST=1 where the suite is fast"
        fi
      fi
    done
  else
    skip python "uv not installed"
  fi
else
  skip python "no pyproject.toml anywhere in this repo"
fi

# Terraform, wherever this repo keeps it: modules/ in the template and
# instances, infra/ and modules/ in siblings.
if [ -n "$LIST" ] || command -v terraform >/dev/null 2>&1; then
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
    ci_has "terraform fmt" && run_check terraform-fmt terraform fmt -check -recursive $tf_dirs
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
JS_DIRS=$(js_dirs)
if [ -n "$JS_DIRS" ]; then
  skip build "excluded - a full app build is too slow for a push gate"
  for d in $JS_DIRS; do
    # Name the package in the label when there is more than one, so a failure
    # says WHERE. A single unlabelled "lint" across three packages is how you
    # end up fixing the wrong one.
    suffix=""
    [ "$d" != "." ] && suffix="(${d#./})"
    for s in lint typecheck format:check test; do
      label="$(printf '%s' "$s" | tr -d ':')$suffix"
      if have_script "$s" "$d"; then
        if [ "$d" = "." ]; then
          run_check "$label" pnpm run "$s"
        else
          run_check "$label" pnpm --dir "$d" run "$s"
        fi
      else
        skip "$label" "no \"$s\" script"
      fi
    done
  done
else
  skip javascript "no package.json anywhere in this repo"
fi

[ -n "$LIST" ] && exit 0

printf '\n'
if [ -n "$FAILED" ]; then
  printf '\033[31mverify failed:\033[0m%s\n' "$FAILED"
  printf 'Fix these here - CI will find them anyway, three minutes and a merge race later.\n'
  printf 'Most format failures are one command: pnpm run format\n\n'
  exit 1
fi
if [ -z "$PASSED" ]; then
  # "Nothing applicable ran" is a different outcome from "checks passed", and
  # conflating them is the exact failure this gate exists to remove -- the
  # standard's own principle, applied to the gate itself. tabsii-crm ran ONE
  # check on a 700-line change and printed a pass (#855).
  #
  # Whether that BLOCKS depends on one thing: does this repo have CI the gate
  # should have mirrored?
  #
  #   - CI exists and the gate ran nothing -> that is the #855 bug. Block.
  #   - No CI at all -> the repo has no shift-left obligation, and blocking
  #     every push there is friction with no benefit. Friction is what drives
  #     people to BIFFO_SKIP_VERIFY, which is a counter-metric H4 pre-registered
  #     as refuting itself. Say it loudly, exit 0.
  #
  # Found immediately: the first run of this rule refused the push in the three
  # repos that have no CI (tabsii-runners, biffo-runners,
  # tabsii-data-model-design) -- blocking the very sync PR that was installing
  # the gate.
  printf '\033[31mverify ran NOTHING - this is not a pass\033[0m\n'
  if [ -f .github/workflows/ci.yml ]; then
    printf 'This repo HAS CI, and the gate mirrored none of it. That is the #855 bug:\n'
    printf 'a gate that reports on work it never checked. Run scripts/gate-coverage.sh\n'
    printf 'to see which of its CI checks are missing.\n\n'
    exit 1
  fi
  printf 'This repo has no CI for the gate to mirror, so there is nothing to shift\n'
  printf 'left. Not blocking -- but nothing was verified here.\n'
  printf 'See docs/practices/standards/local-gates.md\n\n'
  exit 0
fi
printf '\033[32mverify passed\033[0m -%s\n' "$PASSED"
[ -n "$SKIPPED" ] && printf '\033[90mnot applicable here:%s\033[0m\n' "$SKIPPED"
printf '\n'
