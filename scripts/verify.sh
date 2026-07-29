#!/usr/bin/env sh
#
# Run the checks CI runs, here, before the push that would have found them.
#
# ## Why this exists
#
# Until now the only local gate was a whole-project `pyright` in
# `.husky/pre-push`. Everything else — eslint, prettier, tsc, vitest, ruff,
# terraform fmt, the plugin guards — ran for the first time on a GitHub runner,
# after a push, after a PR, after the merge race.
#
# Over the 30 days to 2026-07-29 `biffo-template` had **129 failed CI runs**.
# Breaking down the failing steps:
#
#     34  format check      (pnpm run format:check / ruff format --check)
#     23  tests             (pnpm run test)
#     16  type check        (pyright — the one check that DID run locally)
#     14  lint              (pnpm run lint / ruff check)
#     11  terraform fmt
#     ~2  portal build
#     --
#     ~100 of ~180 failed steps, every one of them reproducible locally in
#     under 40 seconds with no network and no credentials.
#
# The same file failed the same check across consecutive runs — e.g.
# `services/api/src/api/routing/crud_handlers.py` failing `ruff format --check`
# on four separate runs. That is the signature of a round trip being used as the
# check: push, wait for CI, read the failure, fix, push again.
#
# Each of those costs a full CI cycle (~2.5 min p50 here) plus a re-entry into
# the merge race, twice over — once to discover, once to confirm. This script
# costs ~40 seconds and finds them before the first push.
#
# ## What is in it, and what is deliberately not
#
# Everything here is deterministic, offline, and needs no credentials. The
# omissions are on purpose and each has a reason:
#
#   - `uv run pytest` — 56s, more than the rest of the gate combined, and it
#     failed **once** in 30 days. Bad trade at the pre-push point; CI keeps it.
#   - `pnpm --filter @biffo/portal build` — a full Next build.
#   - the dependency audits and gitleaks — network, and history rather than
#     working tree.
#
# Those exclusions are enumerated in `scripts/verify-parity.test.ts`, which
# fails if CI grows a check that is neither here nor listed there. Without that
# test this file rots into a subset of CI within a month and stops being a gate.
#
# Usage:
#   sh scripts/verify.sh          # everything
#   pnpm run verify               # same
#   BIFFO_SKIP_VERIFY=1 git push  # escape hatch, for when you mean it

set -u

FAILED=""
PASSED=""

# Run one check to completion and record the verdict — never stop at the first
# failure. Stopping is what makes a round trip: you fix one thing, push, and
# discover the next. CI itself runs its check steps under `!cancelled()` for the
# same reason, and a local gate that behaves differently is a worse tool than
# the thing it replaces.
check() {
  name="$1"
  shift
  start=$(date +%s)
  if "$@" >/tmp/biffo-verify.$$ 2>&1; then
    PASSED="$PASSED $name"
    printf '  \033[32m✓\033[0m %-22s %ss\n' "$name" "$(($(date +%s) - start))"
  else
    FAILED="$FAILED $name"
    printf '  \033[31m✗\033[0m %-22s %ss\n' "$name" "$(($(date +%s) - start))"
    sed 's/^/      /' /tmp/biffo-verify.$$ | tail -25
  fi
  rm -f /tmp/biffo-verify.$$
}

printf '\nverify — the checks CI runs, before the push\n\n'

# Ordered cheapest-first so the common, trivial failures surface in the first
# second rather than after the test run.
check ruff-check    uv run ruff check .
check ruff-format   uv run ruff format --check .
check terraform-fmt terraform fmt -check -recursive modules/
check plugin-tf     sh scripts/biffo.sh check plugin-terraform
check plugin-names  sh scripts/biffo.sh check plugin-collisions
check lint          pnpm run lint
check typecheck     pnpm run typecheck
check format        pnpm run format:check
check pyright       uv run pyright
check test          pnpm run test

printf '\n'
if [ -n "$FAILED" ]; then
  printf '\033[31mverify failed:\033[0m%s\n' "$FAILED"
  printf 'Fix these here — CI will find them anyway, three minutes and a merge race later.\n'
  printf 'Most format failures are one command: pnpm run format\n\n'
  exit 1
fi
printf '\033[32mverify passed\033[0m —%s\n\n' "$PASSED"
