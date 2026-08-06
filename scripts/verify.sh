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

# Checkout health -- is the tree a command is about to trust stale or dirty in
# the ONE place that matters: the PRIMARY checkout. (#1196)
#
# AGENTS.md SS1/SS2 already say the primary must stay on the integration
# branch, no more than a `git fetch` behind, and that real work happens in
# worktrees instead -- but nothing checked it, and it happened again. An agent
# asked to migrate tabsii-crm's `auth.ts` read an 80-line file exporting five
# extra functions and built a whole, internally consistent, WRONG analysis on
# it: `origin/dev` held 36 lines and one export. The primary checkout it read
# was 16 commits behind, 1 ahead, dirty. The agent's reasoning was sound; its
# input was not, and nothing said so.
#
# This does not naturally belong to a PRE-PUSH file -- the incident above
# never touched git at all, it was a pure read, so a gate that only runs at
# push time could never have caught it by running later. It is here anyway,
# not in `scripts/hook-audit.sh` as the issue itself proposed, for a
# mechanical reason recorded rather than argued away: #1194 (gitleaks scope)
# and this were required to land in the same PR, in this file. Two things
# follow from that:
#
#   `--checkout-health` is the part meant to answer #1196's actual question --
#   run it BEFORE trusting a read, standalone, any time:
#     sh scripts/verify.sh --checkout-health
#
#   The WARN folded into the ordinary run further down is defence in depth for
#   the one case an ordinary PUSH-TIME run can still see: a push attempted
#   FROM the primary, which SS1 forbids outright regardless of staleness.
#   It does not, and cannot, cover the read-only case the issue was filed for.
#
# Scope is deliberately narrow. A WORKTREE being behind `origin/dev` is normal
# mid-work -- that is what branching for a unit of work looks like -- so this
# never evaluates one. It only evaluates the ONE checkout AGENTS.md says must
# always mirror the integration branch: a non-worktree working tree whose
# CURRENT branch IS that branch. A worktree, a detached HEAD, or some other
# branch checked out at a repo root are all out of scope, and reported as
# such (`n/a`) rather than silently read as healthy for a question they were
# never asked.
CHECKOUT_HEALTH_BRANCH="${BIFFO_INTEGRATION_BRANCH:-dev}"

# A linked worktree's git-dir lives under the primary's `.git/worktrees/`; the
# primary's own git-dir does not. That is the one property distinguishing them
# regardless of where either happens to be checked out on disk.
_is_linked_worktree() {
  case "$(git rev-parse --git-dir 2>/dev/null)" in
    */worktrees/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Verdict in CHECKOUT_HEALTH_VERDICT: healthy | stale | n/a | detached | unknown.
# Detail (the "why", for stale/unknown) in CHECKOUT_HEALTH_DETAIL.
#
# Sets globals rather than echoing the verdict for `$(...)` capture on
# purpose: `_v=$(checkout_health)` runs the function in a SUBSHELL, and any
# variable it assigns -- CHECKOUT_HEALTH_DETAIL included -- dies with that
# subshell. The first version did exactly that and every non-trivial verdict
# crashed the caller under `set -u` reading a detail that command substitution
# had already thrown away. Caught by the fail-first rehearsal below, not by
# the happy-path `healthy` case, which never touches DETAIL and looked fine.
checkout_health() {
  CHECKOUT_HEALTH_VERDICT=""
  CHECKOUT_HEALTH_DETAIL=""
  if _is_linked_worktree; then
    CHECKOUT_HEALTH_VERDICT="n/a"
    return 0
  fi
  _ch_branch=$(git symbolic-ref --short -q HEAD) || {
    CHECKOUT_HEALTH_VERDICT="detached"
    return 0
  }
  if [ "$_ch_branch" != "$CHECKOUT_HEALTH_BRANCH" ]; then
    CHECKOUT_HEALTH_VERDICT="n/a"
    return 0
  fi
  _ch_dirty=""
  [ -n "$(git status --porcelain 2>/dev/null)" ] && _ch_dirty=1

  if ! git remote get-url origin >/dev/null 2>&1; then
    CHECKOUT_HEALTH_VERDICT="unknown"
    CHECKOUT_HEALTH_DETAIL="no 'origin' remote configured"
    return 0
  fi

  # A fetch may be the only way to know staleness -- do not hard-fail an
  # offline machine over a question it structurally cannot answer. Bounded so
  # a dead network cannot hang the gate the way an unbounded fetch could; a
  # stale-but-cached remote-tracking ref is still evidence, just older.
  _ch_fetched=1
  timeout 10 git fetch --quiet origin "$CHECKOUT_HEALTH_BRANCH" 2>/dev/null || _ch_fetched=""
  if [ -z "$_ch_fetched" ] && ! git rev-parse -q --verify "origin/$CHECKOUT_HEALTH_BRANCH" >/dev/null 2>&1; then
    CHECKOUT_HEALTH_VERDICT="unknown"
    CHECKOUT_HEALTH_DETAIL="could not reach origin, and no cached origin/$CHECKOUT_HEALTH_BRANCH to fall back on"
    return 0
  fi

  _ch_behind=$(git rev-list --count "HEAD..origin/$CHECKOUT_HEALTH_BRANCH" 2>/dev/null || echo 0)
  _ch_ahead=$(git rev-list --count "origin/$CHECKOUT_HEALTH_BRANCH..HEAD" 2>/dev/null || echo 0)

  if [ -n "$_ch_dirty" ] || [ "${_ch_behind:-0}" -gt 0 ] || [ "${_ch_ahead:-0}" -gt 0 ]; then
    CHECKOUT_HEALTH_VERDICT="stale"
    _ch_bits=""
    [ "${_ch_behind:-0}" -gt 0 ] && _ch_bits="$_ch_bits ${_ch_behind} behind"
    [ "${_ch_ahead:-0}" -gt 0 ] && _ch_bits="$_ch_bits ${_ch_ahead} ahead"
    [ -n "$_ch_dirty" ] && _ch_bits="$_ch_bits dirty"
    CHECKOUT_HEALTH_DETAIL="${_ch_bits# }"
    return 0
  fi

  CHECKOUT_HEALTH_VERDICT="healthy"
  return 0
}

# Standalone entry point. Exits before any of the slower checks below run --
# answering "can I trust this tree" is the whole job, not a side effect of a
# full gate run. FAILS CLOSED on a confirmed-stale tree (exit 1) and on a tree
# it could not evaluate (exit 2) -- "cannot tell" is never a pass, the same
# convention `wait-for-checks.sh` and `branch-health.sh` already use for
# exactly this reason. It does not fail merely for BEING the primary: a clean,
# up-to-date primary on the integration branch is the correct, expected state,
# not a violation -- only staleness and dirt are.
if [ "${1:-}" = "--checkout-health" ]; then
  checkout_health
  case "$CHECKOUT_HEALTH_VERDICT" in
    healthy)
      printf 'checkout-health: OK - on %s, clean, matches origin/%s\n' \
        "$CHECKOUT_HEALTH_BRANCH" "$CHECKOUT_HEALTH_BRANCH"
      exit 0
      ;;
    n/a)
      printf 'checkout-health: n/a - not the primary checkout parked on %s (worktree, detached HEAD, or another branch)\n' \
        "$CHECKOUT_HEALTH_BRANCH"
      exit 0
      ;;
    detached)
      printf 'checkout-health: n/a - detached HEAD, not evaluated\n'
      exit 0
      ;;
    stale)
      printf 'checkout-health: STALE - this checkout is %s\n' "$CHECKOUT_HEALTH_DETAIL"
      printf 'AGENTS.md SS1/SS2: keep the primary on %s, no more than a git fetch\n' "$CHECKOUT_HEALTH_BRANCH"
      printf 'behind, and do real work in a worktree instead. Do not trust anything\n'
      printf 'read from this tree until: git fetch origin && git status\n'
      exit 1
      ;;
    unknown)
      printf 'checkout-health: CANNOT TELL - %s\n' "$CHECKOUT_HEALTH_DETAIL"
      printf 'Not a pass -- reconnect and re-run before trusting this tree.\n'
      exit 2
      ;;
    *)
      printf 'checkout-health: CANNOT TELL - unexpected verdict "%s"\n' "$CHECKOUT_HEALTH_VERDICT"
      exit 2
      ;;
  esac
fi

FAILED=""
PASSED=""
SKIPPED=""
# Checks that were APPLICABLE and did not run. Kept apart from SKIPPED because
# the summary must not print "not applicable here: pg-test" about a lane this
# repo demonstrably has -- absence and blindness reading identically is the
# defect, not a formatting nit.
NOT_RUN=""
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
#
# ABSENT and UNREADABLE are not the same claim either, and collapsing them is
# #1218. `[ -f ]` is true for a file that exists but cannot be opened, so a
# `ci.yml` present-but-unreadable (a permissions oddity, a partial checkout) was
# falling into the same branch as "no CI to mirror" -- except it then made
# EVERY `ci_has()` call answer `grep`'s "cannot open" exit (2) exactly as it
# answers a genuine "not found" (1), because the `&&` every call site gates on
# does not distinguish them. Unlike a repo with no `ci.yml` at all, this repo
# LOOKS like it has CI (`NO_CI` never gets set), so the best-effort fallback
# never fires either -- every ci_has()-gated check just silently vanishes from
# the run, with nothing in the summary naming what went missing. That is worse
# than "ran nothing": checks that do not gate on `ci_has` (JS lint/format among
# them) still run and pass, so the gate does not even reach the "ran NOTHING"
# branch below -- it prints `verify passed` having covered less than it claims.
#
# So this is decided ONCE, here, before a single check runs -- not rediscovered
# independently at each of the eight `ci_has()` call sites, where a per-site fix
# is exactly the kind of second copy that drifts (AGENTS.md's `_extract_detail`
# point). "Cannot tell what CI requires" fails the whole gate immediately, in
# the estate's three-valued convention (0 green, 1 failed, 2 cannot tell --
# wait-for-checks.sh, branch-health.sh, claim.sh): 2 is never a pass, and
# letting the rest of the gate run anyway would produce a partial,
# misleadingly-labelled PASS on top of a question it already could not answer.
CI_YML_UNREADABLE=""
if [ -f .github/workflows/ci.yml ]; then
  [ -r .github/workflows/ci.yml ] || CI_YML_UNREADABLE=1
else
  NO_CI=1
fi

# release-guards.yml (#1319): the "Release Guards" job's own trigger needed
# `edited` added to it (so a PR title/body correction re-evaluates
# automatically), and giving that trigger to the WHOLE build matrix in
# ci.yml would re-run every heavy job on every description tweak -- so the
# job moved to this second file instead (see that file's own header). Its
# absence does NOT mean "no CI to mirror" -- ci.yml alone is still a real CI
# and NO_CI must not fire just because a repo has not adopted the split (a
# sibling never will; an instance not yet upgraded past #1319 has not yet).
# But if it EXISTS and cannot be READ, that is the identical #1218 shape as
# ci.yml itself, and ci_has() must search it too or "practices-monotonic"
# (moved into it) would silently stop being locally mirrored the moment it
# left ci.yml -- covered less than verify.sh claims, with nothing saying so.
RELEASE_GUARDS_YML_UNREADABLE=""
if [ -f .github/workflows/release-guards.yml ] && [ ! -r .github/workflows/release-guards.yml ]; then
  RELEASE_GUARDS_YML_UNREADABLE=1
fi

if [ -n "$CI_YML_UNREADABLE" ] || [ -n "$RELEASE_GUARDS_YML_UNREADABLE" ]; then
  printf '\n\033[31mverify: CANNOT TELL - a core workflow file exists but could not be read\033[0m\n'
  [ -n "$CI_YML_UNREADABLE" ] && printf '  .github/workflows/ci.yml\n'
  [ -n "$RELEASE_GUARDS_YML_UNREADABLE" ] && printf '  .github/workflows/release-guards.yml\n'
  printf 'Permissions, a partial checkout, or a filesystem error -- not "no CI to\n'
  printf 'mirror" (that is a missing ci.yml, handled separately, and does not\n'
  printf 'block). Every check gated on ci_has() would silently be skipped and the\n'
  printf 'gate would still report an unqualified pass, having covered less than it\n'
  printf 'claims (biffo-template#1218).\n'
  printf 'Fix the permissions (or the checkout) and re-run.\n\n'
  exit 2
fi

ci_has() {
  [ -n "${NO_CI:-}" ] && return 0
  grep -qE "$1" .github/workflows/ci.yml && return 0
  [ -f .github/workflows/release-guards.yml ] && grep -qE "$1" .github/workflows/release-guards.yml
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

  # Defence in depth (#1196): the ordinary run only reaches the ONE case it
  # can, a push attempted straight from the primary checkout -- see the long
  # comment above `checkout_health` for why this is a WARN, not a FAIL, and
  # why it does not (cannot) cover the read-only case the issue was filed for.
  # A worktree -- the normal place this script runs -- returns `n/a` here
  # before any git command runs, so this costs nothing on the common path.
  checkout_health
  case "$CHECKOUT_HEALTH_VERDICT" in
    stale)
      printf '  \033[33mWARN\033[0m %-16s this is the primary checkout on %s and it is %s\n' \
        "checkout-health" "$CHECKOUT_HEALTH_BRANCH" "$CHECKOUT_HEALTH_DETAIL"
      printf '       \033[33mAGENTS.md SS1/SS2: never edit or push from the primary -- do the work in a worktree instead.\033[0m\n'
      NOT_RUN="$NOT_RUN checkout-health"
      ;;
    unknown)
      printf '  \033[33mWARN\033[0m %-16s could not verify - %s\n' "checkout-health" "$CHECKOUT_HEALTH_DETAIL"
      ;;
  esac
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

# Postgres-dependent tests -- the lane a SQLite suite cannot stand in for.
#
# Tests that assert on row-level security, real DDL, or anything the app leaves
# to Postgres only mean something against Postgres. They are selected by the
# same CONVENTION their CI lane uses -- a module needing real Postgres is named
# `test_*_pg.py` -- rather than a hand-maintained list, which is a fail-open
# waiting to happen: add a Postgres test, forget the list, and it skips locally
# and runs nowhere.
#
# Why this is here at all. On 2026-08-02 **9 of 13** locally-catchable failing
# CI steps across the estate were this lane, every one of them a genuine
# assertion failure on a feature branch that a local run would have caught. The
# gate simply did not run it: `verify.sh` had no reference to Postgres in any
# form, so a required check that costs a full CI round trip had no local
# counterpart. Measured on tabsii-platform: schema build ~2s, 310 tests ~28s.
#
# The budget is deliberately its own, and larger than pytest's. `pytest_is_fast`
# excludes a suite over 15s because a slow unit suite slows every push for a
# class of failure the fast checks mostly catch first; this lane is the opposite
# trade -- it is the ONLY local sight of a required check, and 30s against a
# ~7-minute CI round trip pays for itself the first time it fires.
PG_TEST_BUDGET_SECONDS="${BIFFO_VERIFY_PG_BUDGET:-120}"
PG_TEST_DSN="${BIFFO_TEST_PG_DSN:-${TABSII_TEST_PG_DSN:-}}"

# `.claude/worktrees` is excluded alongside `.worktrees`, and finding out why
# cost a wrong answer: tabsii-platform reported **66** modules where its CI lane
# runs 40, because an agent tool keeps its worktrees INSIDE the repo under
# `.claude/`. A gate that runs a stale nested checkout's copy of a test would
# fail a push over code that is not being pushed -- and the first such false
# positive is what teaches people to reach for BIFFO_SKIP_VERIFY.
pg_test_modules() {
  find . -name 'test_*_pg.py' \
    -not -path "*/node_modules/*" -not -path "*/.venv/*" \
    -not -path "*/.worktrees/*" -not -path "*/.claude/*" -not -path "*/.git/*" 2>/dev/null | sort
}

# Assert the lane EXERCISED something, not merely that pytest exited 0.
#
# Both inputs degrade to empty silently: a DSN pointing at a database whose
# schema never built makes every module skip, and pytest reports "0 passed" as
# success. A green gate that ran nothing is the exact shape this whole lane
# exists to end, so the summary line is asserted rather than trusted -- the same
# assertions its CI workflow makes, for the same reason.
pg_test_run() {
  _out="/tmp/biffo-verify-pg.$$"
  _pg_started=$(date +%s)
  TABSII_TEST_PG_DSN="$PG_TEST_DSN" BIFFO_TEST_PG_DSN="$PG_TEST_DSN" \
    timeout "$PG_TEST_BUDGET_SECONDS" uv run --directory "$1" pytest -q $2 >"$_out" 2>&1
  _pg_rc=$?
  _pg_elapsed=$(($(date +%s) - _pg_started))

  # `timeout` exits 124 when it kills the command (137 if SIGKILL was needed).
  # Reported apart from a real failure, because they are different facts and
  # this gate used to render them identically: a killed run printed
  # `verify failed: pg-test` with NO failing test named, which reads exactly
  # like a defect and sends the reader hunting one. It happened on
  # tabsii-platform (#703) -- the same push succeeded on retry, unchanged.
  #
  # Same discipline as `wait-for-checks` and the dependency audits: "could not
  # determine" must never wear the clothes of "found something wrong".
  if [ "$_pg_rc" -eq 124 ] || [ "$_pg_rc" -eq 137 ]; then
    echo "TIMED OUT after ${_pg_elapsed}s (budget ${PG_TEST_BUDGET_SECONDS}s)."
    echo ""
    echo "This is INCONCLUSIVE, not a failing test: the lane was killed partway,"
    echo "so nothing below is a verdict on your change. Do not go looking for a"
    echo "bug on this evidence."
    echo ""
    echo "Most likely the lane has simply outgrown its budget. Re-run with more:"
    echo "  BIFFO_VERIFY_PG_BUDGET=$((PG_TEST_BUDGET_SECONDS * 2)) sh scripts/verify.sh"
    echo ""
    echo "If that passes, raise PG_TEST_BUDGET_SECONDS rather than living with a"
    echo "gate that fails at random -- and re-measure the comment above it, which"
    echo "records what the lane cost when the number was last chosen."
    echo ""
    echo "Partial output before the kill (NOT a result):"
    tail -15 "$_out"
    rm -f "$_out"
    return 1
  fi

  if [ "$_pg_rc" -ne 0 ]; then
    cat "$_out"
    rm -f "$_out"
    return 1
  fi
  if grep -qiE '[0-9]+ skipped' "$_out"; then
    echo "A Postgres module reported skips -- the lane exercised nothing."
    echo "The DSN is set but the database is probably missing its schema."
    tail -5 "$_out"
    rm -f "$_out"
    return 1
  fi
  if ! grep -qE '[0-9]+ passed' "$_out"; then
    echo "No tests passed -- the lane did not run."
    tail -5 "$_out"
    rm -f "$_out"
    return 1
  fi
  # A pass with almost no headroom is the state just before the confusing
  # failure above, and it is silent unless somebody says so. 80% is early
  # enough to act on and rare enough not to become noise.
  if [ "$((_pg_elapsed * 100))" -gt "$((PG_TEST_BUDGET_SECONDS * 80))" ]; then
    printf '\033[33m  note: pg-test took %ss of a %ss budget -- raise PG_TEST_BUDGET_SECONDS before it starts timing out at random.\033[0m\n' \
      "$_pg_elapsed" "$PG_TEST_BUDGET_SECONDS"
  fi
  rm -f "$_out"
  return 0
}

_pg_modules=$(pg_test_modules)

# Provision the database rather than requiring the operator to remember.
#
# A gate that only runs when you exported the right variable is a gate that runs
# on the days you did not need it. `scripts/pg-test-db.sh` is idempotent and
# cheap when the schema is unchanged (~0.3s; ~4s when it genuinely has to
# rebuild), so calling it is better than warning about it. Failure is silent
# BECAUSE the WARN below is the honest report of it -- no Docker, no server, no
# schema all end in the same place: the lane did not run, and the gate says so.
if [ -z "$PG_TEST_DSN" ] && [ -n "$_pg_modules" ] && [ -z "$LIST" ]; then
  # Through the bridge since #1109; the `-f scripts/pg-test-db.sh` guard went
  # with the copy. Failure stays silent here BECAUSE the WARN below is the
  # honest report of it -- no Docker, no server, no schema and no CLI all end
  # in the same place: the lane did not run, and the gate says so.
  PG_TEST_DSN=$(sh scripts/biffo.sh pg-test-db 2>/dev/null | tail -1) || PG_TEST_DSN=""
  case "$PG_TEST_DSN" in
    postgres*) ;;
    *) PG_TEST_DSN="" ;;
  esac
fi

# Order matters, and getting it wrong made these very tests machine-dependent:
# with `uv not installed` checked FIRST, a runner without uv skipped quietly and
# the gap warning never printed -- green on a workstation, red on CI, for a
# reason unconnected to the change. "This repo has a lane and nothing local is
# checking it" is true whether or not uv is installed, and it is the more
# actionable of the two, so it is reported first. `uv` is only required to
# actually RUN the lane.
if [ -z "$_pg_modules" ]; then
  skip pg-test "no Postgres-dependent tests (test_*_pg.py) in this repo"
elif [ -z "$PG_TEST_DSN" ]; then
  # NOT a quiet `--`. Every other skip in this file means "this repo does not
  # have the thing"; this one means "this repo HAS the thing and the gate is
  # blind to it", which is the fail-open shape, and printing the two the same
  # way is how a gap gets read as coverage. It stays a skip rather than a
  # failure because a push must not be blocked by a database being down -- but
  # it says so where it cannot be missed, and names the command that fixes it.
  if [ -z "$LIST" ]; then
    NOT_RUN="$NOT_RUN pg-test"
    printf '  \033[33mWARN\033[0m %-16s NOT RUN - %s Postgres module(s) present, no DSN set\n' \
      "pg-test" "$(echo "$_pg_modules" | wc -l | tr -d ' ')"
    printf '       \033[33m%s\033[0m\n' \
      "CI runs these as a required check; nothing local is checking them."
    printf '       \033[90m%s\033[0m\n' \
      "set BIFFO_TEST_PG_DSN, or run scripts/pg-test-db.sh if this repo ships one"

    # --- Block on a relevant diff (tabsii-platform#656) --------------------
    #
    # The line above is honest -- it says NOT RUN, not passing -- but that is
    # not enough on its own: it does not block, and a wall of green `OK` lines
    # trains a reader not to weight one amber line correctly. It surfaced on a
    # push that was ENTIRELY RLS policy DDL, exactly the diff this lane exists
    # to check.
    #
    # `BIFFO_PGTEST_DIFF_RELEVANT` is set by `.githooks/pre-push`, never by a
    # developer -- it is the hook's answer to "does this push touch
    # db/imports/** or a *_pg.py module?", computed from the actual ref list
    # via `scripts/pgtest-diff-check.sh`. A plain `sh scripts/biffo.sh verify`
    # run by hand therefore stays advisory, exactly as before: this variable is
    # only ever present when the hook itself decided the diff warranted it.
    #
    # `BIFFO_SKIP_PGTEST` is checked again here, not only in the hook, so this
    # is provable by driving verify.sh directly (see verify-pg-lane.test.ts)
    # and so a developer who sets it before invoking verify.sh by hand gets the
    # same escape hatch the hook advertises.
    if [ -n "${BIFFO_PGTEST_DIFF_RELEVANT:-}" ] && [ -z "${BIFFO_SKIP_PGTEST:-}" ]; then
      FAILED="$FAILED pg-test-required"
      printf '\n'
      printf '  \033[31mBLOCKED\033[0m: this push touches db/imports/** or a *_pg.py module, and\n'
      printf '  the pg-test lane above did not run. CI treats it as a required check, so a\n'
      printf '  push here would report green without having checked the thing most likely\n'
      printf '  to need it.\n\n'
      printf '  Get a DSN and re-run:\n'
      printf '    eval "$(sh scripts/pg-test-db.sh --export)"   # if this repo ships one\n'
      printf '    export BIFFO_TEST_PG_DSN=postgresql+asyncpg://user:pass@host:port/db\n\n'
      printf '  Deliberate escape hatch, printed rather than silent (AGENTS.md section 7):\n'
      printf '    BIFFO_SKIP_PGTEST=1 git push ...\n\n'
    fi
  fi
elif ! command -v uv >/dev/null 2>&1; then
  skip pg-test "uv not installed"
else
  # Run from the uv project that owns the modules, with paths relative to it, so
  # this works wherever a repo keeps its API (root here, services/api in every
  # instance and sibling).
  _pg_dir=$(echo "$_pg_modules" | head -1)
  while [ "$_pg_dir" != "." ] && [ "$_pg_dir" != "/" ]; do
    _pg_dir=$(dirname "$_pg_dir")
    [ -f "$_pg_dir/pyproject.toml" ] && break
  done
  if [ ! -f "$_pg_dir/pyproject.toml" ]; then
    skip pg-test "no pyproject.toml above the Postgres modules"
  else
    _pg_rel=$(echo "$_pg_modules" | sed "s|^$_pg_dir/||" | tr '\n' ' ')
    # shellcheck disable=SC2086
    run_check pg-test pg_test_run "$_pg_dir" "$_pg_rel"
  fi
fi

# Terraform, wherever this repo keeps it: modules/ in the template and
# instances, infra/ and modules/ in siblings, terraform/ in the runner fleets.
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
  # terraform/ is the whole of a runner fleet (#1239). Both fleets kept every
  # .tf file there, which is neither of the two directories above, so `tf_dirs`
  # came out empty and this gate printed `no terraform in this repo` -- in the
  # two repos that are nothing BUT terraform. Their CI does check it
  # (`terraform fmt -check -recursive terraform/`), so the gap was local only:
  # the gate that exists to catch this before the push was the one thing not
  # catching it. No repo in the estate holds both terraform/ and modules/, so
  # adding it cannot widen scope anywhere that was already covered.
  [ -d terraform ] && tf_dirs="$tf_dirs terraform/"
  if [ -n "$tf_dirs" ]; then
    # shellcheck disable=SC2086
    ci_has "terraform fmt" && run_check terraform-fmt terraform fmt -check -recursive $tf_dirs
  else
    # Distinguish "this repo has no terraform" from "this repo has terraform
    # somewhere I do not look". The old message asserted the first and was
    # printed for the second, which is the difference between a considered skip
    # and a blind spot wearing its clothes -- the same shape as a branch audit
    # dropping the repos it could not read (#1145) and reporting the remainder
    # as the whole.
    # Pruned rather than filtered, and NOT capped: `| head -20 | wc -l` would
    # silently report 20 for a repo with 200, and a count that stops counting is
    # the denominator defect this estate keeps re-learning.
    _tf_stray=$(find . \
      \( -name .git -o -name .worktrees -o -name .terraform -o -name node_modules \) -prune \
      -o -name '*.tf' -print 2>/dev/null | wc -l | tr -d ' ')
    if [ "${_tf_stray:-0}" -gt 0 ] && [ -z "$LIST" ]; then
      # A WARN, not a skip and not a failure -- exactly the posture pg-test
      # takes above for "the repo HAS the thing and the gate is blind to it".
      # Not a failure because the right scope depends on what this repo's CI
      # covers, which this gate cannot decide for a layout nobody has declared.
      NOT_RUN="$NOT_RUN terraform-fmt"
      printf '  \033[33mWARN\033[0m %-16s NOT RUN - %s .tf file(s) present, none in a directory this gate checks\n' \
        "terraform-fmt" "$_tf_stray"
      printf '       \033[33m%s\033[0m\n' \
        "it looks in modules/, infra/ (siblings) and terraform/ - this repo uses none of them"
      printf '       \033[90m%s\033[0m\n' \
        "add the directory to the tf_dirs block in scripts/verify.sh (biffo-template#1239)"
    else
      skip terraform-fmt "no .tf files in modules/, infra/ or terraform/"
    fi
  fi
else
  skip terraform-fmt "terraform not installed"
fi

# The Biffo guards, where the dispatcher exists. Cheap, and two of them
# (ownership, plugin-terraform) were being caught in CI.
if [ -f scripts/biffo.sh ]; then
  run_check plugin-tf sh scripts/biffo.sh check plugin-terraform
  run_check plugin-names sh scripts/biffo.sh check plugin-collisions
  run_check adr-numbering sh scripts/biffo.sh check adr-numbering
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

# Terraform plan artefacts, refused by CONTENT (biffo-runners#1).
#
# A saved plan is a zip. `strings`/`grep` over it is a false-negative machine —
# a pre-commit check on `terraform/tfplan2` reported it clean and it carried a
# live private key. gitleaks cannot see inside it either, so the working-tree
# pass below is no protection: the bytes are compressed.
#
# So the answer is not a better scanner, it is refusing to track the artefact at
# all. Name-based ignoring already failed: `.gitignore` carried `tfplan`, and the
# file that nearly leaked was `tfplan2`.
#
# Detection is content-first: a zip magic (`PK\003\004`) whose central
# directory names a `tfplan` member. Filenames are stored uncompressed in a zip,
# so this needs no `unzip` and works on any machine.
# Skipped for --list, which must answer a question about the repo without doing
# work. Measured 4.2s over 907 tracked files before this gate existed, which
# timed out three parity tests that only wanted the check NAMES.
#
# Candidates are narrowed by extension FIRST, then detected by content. The
# narrowing is not a weakening: the files it skips are text, and text is exactly
# what gitleaks can already scan. The whole reason a plan needs its own guard is
# that its bytes are compressed and no scanner can read them.
#
# `read -r -d ""` is a bashism and this file runs under `sh`. Using it here made
# the loop error and the guard report nothing — a fail-open inside the guard
# written to close one. It passed `sh -n`, because the syntax is valid; only
# running it revealed the failure.
plan_artefacts=""
if [ -z "$LIST" ]; then
  plan_artefacts=$(
    git ls-files | while IFS= read -r f; do
      case "$f" in
        *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.py|*.md|*.json|*.yml|*.yaml|*.tf|\
        *.tfvars|*.sh|*.toml|*.txt|*.css|*.html|*.svg|*.lock|*.snap|*.sql) continue ;;
      esac
      [ -f "$f" ] || continue
      case $(head -c 4 "$f" 2>/dev/null | od -An -c 2>/dev/null | tr -d " ") in
        # -a because the file is binary and grep would otherwise decline to report.
        PK003004) LC_ALL=C grep -aq tfplan "$f" 2>/dev/null && printf "%s\n" "$f" ;;
      esac
    done
  )
fi
if [ -n "$plan_artefacts" ]; then
  printf "\033[31mFAIL\033[0m terraform plan artefact is tracked:\n"
  printf "  %s\n" $plan_artefacts
  printf "A saved plan is a zip and routinely contains credentials. It cannot be\n"
  printf "scanned by gitleaks or by grep. Remove it from the index:\n"
  printf "  git rm --cached <file>\n\n"
  exit 1
fi

# gitleaks, WORKING-TREE pass only (#897). `--no-git` is what CI's second pass
# runs, and it is the half a pre-push gate can meaningfully do.
#
# Not installed is reported, never assumed clean. A secret scanner that silently
# does nothing and lets the gate print `verify passed` is the precise failure this
# whole file exists to prevent, and it would be worse here than elsewhere: the
# thing not being checked is credentials.
#
# Scoped to TRACKED files only (#1194). `--no-git` walks the filesystem, not the
# index, and does not honour `.gitignore` -- so anything a build leaves behind
# gets scanned too. An agent in tabsii-crm ran `pnpm run build`, then hit this
# gate scanning 218MB of `.next/`/`out/` and got 30 phantom leaks, none in a
# tracked file, none of them committable. A scanner that cries wolf is worse
# than a slow one: the second time 30 leaks turn out to be bundle noise, people
# stop reading gitleaks output, which is exactly the day a real one hides in it.
#
# The fix is not a broader `.gitleaks.toml` allowlist -- that has to be kept in
# step with `.gitignore` by hand, in every repo this file runs in, forever, and
# it is the wrong shape besides: AGENTS.md SS7 says never fix a scan failure by
# editing the allowlist, and a path-list that grows to cover every build tool's
# output directory is that same fix wearing a different hat. It is narrowed to
# what the gate is actually FOR instead: nothing untracked can reach the remote
# a push sends to, so nothing untracked needs to be able to fail a push.
# `gitleaks_tracked_only` (below) mirrors `git ls-files` into a scratch
# directory -- current on-disk content, not HEAD, so a secret staged into an
# already-tracked file is still caught before the commit that would push it --
# and scans that copy. Relative paths inside the copy match the repo, so the
# existing path-based `.gitleaks.toml` allowlist entries keep working unchanged.
gitleaks_tracked_only() {
  _gl_dir=$(mktemp -d "${TMPDIR:-/tmp}/biffo-gitleaks.XXXXXX") || return 1
  _gl_root=$(git rev-parse --show-toplevel) || {
    rm -rf "$_gl_dir"
    return 1
  }
  # Newline-delimited, not `git ls-files -z` + `read -d ''`: `-d` is a bashism
  # dash does not implement, and this file runs under `sh`
  # (shell-portability.test.ts enforces it). The `plan_artefacts` loop above
  # already made this exact call for the same reason.
  ( cd "$_gl_root" && git ls-files ) | while IFS= read -r _f; do
    [ -f "$_gl_root/$_f" ] || continue
    mkdir -p "$_gl_dir/$(dirname "$_f")"
    cp -p "$_gl_root/$_f" "$_gl_dir/$_f" 2>/dev/null
  done
  # No explicit `--config`, deliberately. gitleaks' own default resolution
  # looks for `.gitleaks.toml` at "(target path)", which is `--source` -- i.e.
  # the mirrored copy, where the file already sits at its usual relative path
  # if this repo tracks one. A first cut passed `--config "$_gl_root/.gitleaks.toml"`
  # to remove any doubt about that resolution, and it was a regression:
  # against a repo with NO `.gitleaks.toml` at all -- a real, valid state,
  # since gitleaks otherwise falls back to its built-in default ruleset --
  # a literal `--config` path that does not exist is FATAL ("unable to load
  # gitleaks config"), where the flagless form degrades gracefully to
  # defaults, identical to what this repo ran before #1194. Verified by
  # running both forms against a `--source` with no config file present.
  gitleaks detect --no-git --redact --exit-code=2 --source "$_gl_dir"
  _gl_status=$?
  rm -rf "$_gl_dir"
  return $_gl_status
}

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
    run_check gitleaks gitleaks_tracked_only
  else
    # Say how to close it, pinned to the version ci.yml installs. A skip that
    # only reports its own absence stays skipped: this one sat `n/a` long
    # enough for the `\b\d{12}\b` account-id rule to reach CI three times,
    # most recently on two test UUIDs whose last segment happened to be
    # twelve digits (tabsii-platform#446). Thirty seconds of install would
    # have caught it before the push, and version parity matters — an older
    # gitleaks disagreeing with CI reintroduces exactly the local/CI
    # divergence this gate exists to remove.
    skip gitleaks "not installed - CI still runs both passes. Install the version ci.yml pins:
       curl -sSfL -o /tmp/gl.tgz https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \\
         && tar -xzf /tmp/gl.tgz -C \"\$HOME/.local/bin\" gitleaks"
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
[ -n "$NOT_RUN" ] && printf '\033[33mAPPLICABLE BUT NOT RUN:%s - CI checks this and the gate did not\033[0m\n' "$NOT_RUN"
# Say which question was answered. Without this, a repo whose ci.yml was deleted
# prints exactly what a fully-mirrored repo prints (#942).
[ -n "${NO_CI:-}" ] && printf '\033[33mno ci.yml - nothing to mirror, so every applicable check ran as\nbest-effort. This is NOT evidence that CI requires them. If this repo is\nmeant to have CI, its workflow is missing.\033[0m\n'
printf '\n'
