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
#   - gitleaks HISTORY pass -- genuinely scans git history, which a pre-push gate
#     cannot usefully anticipate.
#
# The gitleaks WORKING-TREE pass is no longer excluded (#897). The old reason
# here read "gitleaks -- scans history, not the working tree", which was false:
# ci.yml runs two passes, and the second is `gitleaks detect --no-git`, i.e.
# exactly the working tree, which is what a pre-push gate is for. An exclusion
# must describe what the CI step actually DOES -- the same defect as the bandit
# exclusion that claimed "the finding gate is the upload step" (#855).
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
# Defined up here, not inside run_check. `run_check` returns EARLY in --list
# mode, before it would set this -- so `pytest_record "$d" "$LAST_CHECK_SECONDS"`
# read an unset variable and `set -u` killed the script silently, mid-list.
#
# The damage was invisible and downstream: gate-coverage.sh reads --list, so a
# truncated list looked like MISSING COVERAGE. tabsii-geo dropped from 8/8 to
# 4/8 -- and only in repos where a pytest measurement already existed, i.e. only
# after the gate had run there once. A defect that appears on second use is the
# hardest kind to attribute.
LAST_CHECK_SECONDS=""

# pytest is included where the suite is FAST ENOUGH TO PAY, measured rather than
# opted into (#869, H5 gap 4).
#
# The old rule was a blanket exclusion with a manual opt-in nobody ever issued,
# so the fastest suites in the estate were the ones not being run:
#
#   tabsii-marketplace 1.7s   tabsii-geo 2.1s   tabsii-intake 2.5s   tabsii-crm 2.7s
#   biffo-template 51.2s      biffo-platform 57.4s   tabsii-platform 85.6s
#
# The exclusion was right for the three repos it was written against and wrong
# for the four it was applied to. The arithmetic: ~2.5s on every push against a
# ~14 min sibling CI round trip to discover and confirm a Python test failure --
# break-even at one catch per 336 pushes, against an observed rate of roughly
# one per 165.
#
# The command is plain `pytest -q`, matching CI. `--no-cov` looked like a free
# speed-up and is a **pytest-cov flag**: repos without that plugin -- e.g.
# biffo-plugin-ideation, whose CI runs `uv run pytest -q` -- reject it outright
# with `unrecognized arguments`. That is the gate failing where CI passes, which
# H5 pre-registered as a condition that refutes it, and it was caught during
# rollout rather than by review.
#
# BIFFO_VERIFY_PYTEST overrides in BOTH directions: 1 forces it in, 0 forces it
# out. An override that only forces on would leave no way to escape a suite that
# has quietly grown past the threshold.
PYTEST_BUDGET_SECONDS="${BIFFO_VERIFY_PYTEST_BUDGET:-15}"
# How long a measurement is trusted before being re-taken. Only ever matters for
# a `slow` verdict; a `fast` one is re-measured by every run that uses it.
PYTEST_MAX_AGE_DAYS="${BIFFO_VERIFY_PYTEST_MAX_AGE_DAYS:-7}"
PYTEST="${BIFFO_VERIFY_PYTEST:-}"

# Cached per directory, because timing the suite to decide whether to run the
# suite would cost exactly what it is trying to save. The cache lives with the
# repo, not in $HOME, so it cannot leak a fast verdict from one repo to another.
# Where the measurement lives.
#
# NOT in the working tree. The first version wrote `$_d/.pytest-duration` and
# was gitignored in biffo-template only -- .gitignore is not a synced file, so
# every other repo in the estate grew an untracked `?? services/api/.pytest-duration`
# the moment the gate ran. A cache that dirties `git status` in fifteen repos is
# a defect regardless of what it caches.
#
# The git common dir is outside every working tree, shared by all worktrees of a
# clone (they run the same suite), and cannot be committed by accident. Keyed by
# the directory measured, so a root suite and services/api do not collide.
pytest_cache_file() {
  _cd=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/biffo-verify
  mkdir -p "$_cd" 2>/dev/null || true
  printf '%s/pytest-%s' "$_cd" "$(printf '%s' "$1" | tr '/.' '__')"
}

# Record what a real run actually took. The gate runs pytest whenever it believes
# the suite is fast, so it observes the true duration every single time -- and
# throwing that away was the whole bug. A suite that grows past the budget now
# excludes itself on the next push, for free and exactly.
pytest_record() {
  [ -n "${2:-}" ] || return 0
  printf '%s\n' "$2" > "$(pytest_cache_file "$1")" 2>/dev/null || true
}

pytest_is_fast() {
  _d="$1"
  _cache=$(pytest_cache_file "$_d")
  # Age matters in ONE direction. A `fast` verdict is re-confirmed by every run
  # (pytest_record), so it cannot go stale. A `slow` verdict is never re-tested,
  # because the whole point of it is that the suite does not run -- so a suite
  # that has since been split or sped up stays excluded for ever. Expiry is what
  # gives it a way back in.
  if [ -f "$_cache" ] && [ -n "$(find "$_cache" -mtime "-$PYTEST_MAX_AGE_DAYS" 2>/dev/null)" ]; then
    _secs=$(cat "$_cache" 2>/dev/null)
  elif [ -f "$_cache" ] && [ -n "$LIST" ]; then
    # Expired, and --list must not run a suite to answer a question. Use the
    # stale value rather than guessing: it is evidence, just old.
    _secs=$(cat "$_cache" 2>/dev/null)
  elif [ -n "$LIST" ]; then
    # --list must not run a test suite to answer a question about the repo, so
    # with no cached measurement it has to guess -- and the direction of the
    # guess is the whole decision.
    #
    # Guessing "fast" makes --list CLAIM a check the gate may not run, which is
    # the fail-open direction and exactly what this tooling exists to eliminate.
    # Guessing "slow" makes it under-report a check the gate does run: visible,
    # conservative, and self-correcting, because the first real run writes the
    # measurement and every --list after that is exact.
    #
    # Both directions were tried. Under-reporting is the one that cannot lie
    # about coverage.
    _secs=99999
  else
    # First run in a repo: time it once, then decide from then on. A timeout
    # means "too slow", which is the correct verdict rather than a hang.
    _start=$(date +%s)
    if [ "$_d" = "." ]; then
      timeout "$((PYTEST_BUDGET_SECONDS * 4))" uv run pytest -q >/dev/null 2>&1 || true
    else
      timeout "$((PYTEST_BUDGET_SECONDS * 4))" uv run --directory "$_d" pytest -q >/dev/null 2>&1 || true
    fi
    _secs=$(($(date +%s) - _start))
    printf '%s\n' "$_secs" > "$_cache" 2>/dev/null || true
  fi
  [ "${_secs:-9999}" -le "$PYTEST_BUDGET_SECONDS" ]
}

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
# NO_CI is set once, up front, so the two states this predicate conflates stay
# distinguishable to the reader even though it answers the same for both (#942).
# "Yes, CI runs this" and "there is no CI to ask" are not the same claim, and a
# repo that LOST its ci.yml must not read as maximally covered. The summary
# below says which one produced the run.
[ -f .github/workflows/ci.yml ] || NO_CI=1

ci_has() {
  [ -n "${NO_CI:-}" ] && return 0
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
    LAST_CHECK_SECONDS=$(($(date +%s) - start))
    printf '  \033[32mOK\033[0m   %-16s %ss\n' "$name" "$LAST_CHECK_SECONDS"
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

if [ -z "$LIST" ]; then
  # State which template this gate came from. A gate two versions old is the
  # condition that let tabsii-crm print `verify passed` on a 700-line change
  # while running one check, and nothing in the repo said so (#869, H5 gap 1).
  _stamp=""
  [ -f .biffo-shared-version ] && _stamp=" (template $(cat .biffo-shared-version))"
  printf '\nverify - the checks CI runs, before the push%s\n\n' "$_stamp"
fi

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
        if [ "$PYTEST" = "0" ]; then
          skip "pytest$suffix" "excluded by BIFFO_VERIFY_PYTEST=0"
        elif [ -n "$PYTEST" ] || pytest_is_fast "."; then
          if ci_has "pytest"; then
            run_check "pytest$suffix" uv run pytest -q
            # Re-confirm the verdict from what the run actually took. This is the
            # invalidation that costs nothing: the gate has just measured the
            # suite, so a suite that has grown past the budget excludes itself on
            # the next push rather than slowing every push for ever.
            pytest_record "." "$LAST_CHECK_SECONDS"
          fi
        else
          skip "pytest$suffix" "suite is slower than ${PYTEST_BUDGET_SECONDS}s - CI keeps it"
        fi
      else
        ci_has "ruff check" && run_check "ruff-check$suffix" uv run --directory "$d" ruff check .
        ci_has "ruff format" && run_check "ruff-format$suffix" uv run --directory "$d" ruff format --check .
        ci_has "pyright" && run_check "pyright$suffix" uv run --directory "$d" pyright
        ci_has "bandit" && run_check "bandit$suffix" uv run --directory "$d" bandit -r src -ll -q
        if [ "$PYTEST" = "0" ]; then
          skip "pytest$suffix" "excluded by BIFFO_VERIFY_PYTEST=0"
        elif [ -n "$PYTEST" ] || pytest_is_fast "$d"; then
          if ci_has "pytest"; then
            run_check "pytest$suffix" uv run --directory "$d" pytest -q
            pytest_record "$d" "$LAST_CHECK_SECONDS"
          fi
        else
          skip "pytest$suffix" "suite is slower than ${PYTEST_BUDGET_SECONDS}s - CI keeps it"
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

# The append-only corpus guard (#778). CI runs it in Release Guards, and it was
# invisible to the parity test until #897 widened the harvester -- it is neither
# `pnpm`, `uv`, `terraform` nor `sh scripts/`, so the guard whose property is
# "every CI check is in the gate or explicitly excluded" could not see it at all.
# Measured 0.06s here, which is cheaper than every other check in this file.
if [ -f scripts/practices-monotonic.mjs ]; then
  ci_has "practices-monotonic" && run_check corpus-append-only node scripts/practices-monotonic.mjs
fi

# gitleaks, WORKING-TREE pass only (#897). `--no-git` is what CI's second pass
# runs, and it is the half a pre-push gate can meaningfully do.
#
# Not installed is reported, never assumed clean. A secret scanner that silently
# does nothing and lets the gate print `verify passed` is the precise failure this
# whole file exists to prevent, and it would be worse here than elsewhere: the
# thing not being checked is credentials.
if ci_has "gitleaks"; then
  # The installation check gates EXECUTION only, never `--list`.
  #
  # `--list` reports what THIS REPO requires, deliberately independent of what the
  # machine happens to have (see the --list contract at the top of this file), and
  # verify-parity.test.ts reads `--list`. A first cut wrapped the whole branch in
  # `command -v gitleaks`, which made the listed check set machine-dependent: on a
  # machine without gitleaks the parity test then reported the gate as missing a
  # check it does declare. The parity test caught it.
  #
  # `terraform-fmt` above has the same shape and is only unexposed because
  # terraform happens to be installed here. Recorded, not fixed in this change.
  if [ -n "$LIST" ] || command -v gitleaks >/dev/null 2>&1; then
    run_check gitleaks gitleaks detect --no-git --redact --exit-code=2
  else
    skip gitleaks "gitleaks not installed - CI still runs both passes"
  fi
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
# Say which question was answered. Without this, a repo whose ci.yml was deleted
# prints exactly what a fully-mirrored repo prints (#942).
[ -n "${NO_CI:-}" ] && printf '\033[33mno ci.yml - nothing to mirror, so every applicable check ran as\nbest-effort. This is NOT evidence that CI requires them. If this repo is\nmeant to have CI, its workflow is missing.\033[0m\n'
printf '\n'
