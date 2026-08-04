#!/bin/sh
#
# Runs the vitest suite for every nested, standalone pnpm project this repo
# ships OUTSIDE its own root workspace. Today that is exactly
# `_skeletons/sibling-template/apps/frontend` — the canonical copy of
# `api-client.ts` / `auth.ts` distributed to all seven siblings via
# `shared-files.json`'s `filesIfPresent`.
#
# ## Why this exists (#1285)
#
# `_skeletons/` sits outside the root `pnpm-workspace.yaml`'s package globs on
# purpose (see that skeleton's own `pnpm-workspace.yaml`, which exists
# specifically to stop `pnpm install` walking up into this repo's workspace) —
# so no other job in `ci.yml` touched it, a fact `js-dependency-audit.sh` used
# to say about itself before #644/#1270 closed the identical gap for
# dependency audits. #1277 added 223 lines of tests for the 401-refresh logic
# in `api-client.ts`, and all 9 CI checks passed without ever importing them —
# the 16 tests covering the change were run by hand, on a laptop, and pasted
# into the PR body. A regression there merges green today, and it is a
# one-way overwrite into seven repos.
#
# ## Discovery, not a fixed path (mirrors #1270)
#
# A hardcoded `cd _skeletons/sibling-template/apps/frontend` would reproduce,
# one level further down, the exact failure mode #1270 fixed for the
# dependency audit: green forever on a directory it stopped looking at the
# moment a path changed, and blind by construction to anywhere else the
# estate grows a nested pnpm project. `_skeletons/plugin-template/web` and
# `web-admin` — the shape real plugin repos carry — do not exist in this
# template today (checked: no such directories, and nothing in
# `plugin-scaffold.ts` generates them), but nothing here needs editing the day
# they do.
#
# So every `pnpm-lock.yaml` under the repo is discovered by walking from the
# git root, exactly as `js-dependency-audit.sh` already does, EXCLUDING the
# root workspace's own lockfile — that tree's tests already run in the `js`
# job's own `pnpm run test` step, and running it again here would just double
# the work for no new coverage.
#
# ## Fail closed on discovery (#1291, #1301)
#
# Zero discovered nested trees is not "nothing to test" — this repo has
# shipped at least one nested frontend (the sibling skeleton) throughout, so
# finding none means discovery itself is broken (wrong root, an over-eager
# prune, a renamed directory), not that the estate has nothing left to check.
# "This checked nothing" is a configuration error, not a pass — the posture
# #1291 required of the dependency audits and #1301 of the adoption report.
# The same discipline applies one level down: a tree that runs `test` but
# matches zero `*.test.ts(x)` files looks identical to "clean" unless
# something actually counts what ran, so this counts them itself rather than
# trusting vitest's own exit code to be the only backstop.
#
# POSIX sh (the CI step runs `sh scripts/...`, i.e. dash) — no `pipefail`.
set -u

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  echo "::error::nested-frontend-tests: not inside a git repository ('git rev-parse --show-toplevel' failed). Discovery cannot walk a tree it cannot find." >&2
  exit 2
fi

ROOT_LOCK="$REPO_ROOT/pnpm-lock.yaml"

ALL_LOCKS=$(find "$REPO_ROOT" \
  \( -name node_modules -o -name .git -o -name .worktrees \) -prune -o \
  -type f -name pnpm-lock.yaml -print 2>/dev/null | sort)

NESTED_LOCKS=""
for lock in $ALL_LOCKS; do
  [ "$lock" = "$ROOT_LOCK" ] && continue
  NESTED_LOCKS="${NESTED_LOCKS}${NESTED_LOCKS:+
}${lock}"
done

if [ -z "$NESTED_LOCKS" ]; then
  printf '::error::nested-frontend-tests: discovered ZERO nested pnpm-lock.yaml trees under %s (root workspace lockfile excluded).\n' "$REPO_ROOT" >&2
  printf 'This checked nothing. That is a configuration error, not a pass — see #1285/#1270.\n' >&2
  exit 2
fi

tree_count=$(printf '%s\n' "$NESTED_LOCKS" | wc -l | tr -d ' ')
printf 'nested-frontend-tests: discovered %s nested tree(s):\n' "$tree_count"
for lock in $NESTED_LOCKS; do
  dir=$(dirname "$lock")
  rel=${dir#"$REPO_ROOT"/}
  printf '  - %s\n' "$rel"
done

failed=0
tested_trees=0

for lock in $NESTED_LOCKS; do
  dir=$(dirname "$lock")
  rel=${dir#"$REPO_ROOT"/}

  if [ ! -f "$dir/package.json" ]; then
    echo "::error::nested-frontend-tests: ${rel} has a pnpm-lock.yaml but no package.json — cannot tell whether it has a test script." >&2
    failed=1
    continue
  fi

  # grep, not node — no toolchain guaranteed yet (install for THIS tree
  # hasn't run). Deliberately not anchored to line start, matching
  # verify.sh's have_script(): that only matches a pretty-printed
  # package.json, and a minified one would silently report "no test script".
  if ! grep -qE '"test"[[:space:]]*:' "$dir/package.json"; then
    echo "::error::nested-frontend-tests: ${rel}/package.json declares no \"test\" script — a nested tree with no way to run its tests is exactly the gap this script exists to close." >&2
    failed=1
    continue
  fi

  test_file_count=$(find "$dir" -name node_modules -prune -o -type f \
    \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' -o -name '*.test.jsx' \) -print 2>/dev/null \
    | wc -l | tr -d ' ')
  if [ "$test_file_count" -eq 0 ]; then
    echo "::error::nested-frontend-tests: ${rel} has a test script but zero *.test.ts(x)/*.test.js(x) files — failing rather than reporting a silent, unfalsifiable pass." >&2
    failed=1
    continue
  fi

  echo "== ${rel}: installing (${test_file_count} test file(s) discovered) =="
  # --ignore-workspace: this is a standalone project vendored inside the repo,
  # not a member of the root pnpm workspace. Without it pnpm would walk up,
  # find the root workspace, and install that instead — the exact failure
  # mode js-dependency-audit.sh's own comments describe for skeleton trees.
  if ! (cd "$dir" && pnpm install --frozen-lockfile --ignore-workspace); then
    echo "::error::nested-frontend-tests: ${rel} — pnpm install failed." >&2
    failed=1
    continue
  fi

  echo "== ${rel}: pnpm run test =="
  if ! (cd "$dir" && pnpm run test); then
    echo "::error::nested-frontend-tests: ${rel} — tests failed." >&2
    failed=1
    continue
  fi

  tested_trees=$((tested_trees + 1))
done

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "nested-frontend-tests: ${tested_trees} tree(s) tested, 0 failures."
exit 0
