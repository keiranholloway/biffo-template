#!/usr/bin/env sh
#
# Guard for biffo-template#1731 item 2: are the skeletons' OWN uv.lock files
# still in sync with their OWN pyproject.toml, in THIS repo's CI -- not the
# repos scaffolded from them?
#
# ## Why this is a different check from uv-sync-locked.test.sh
#
# PR #1760 / #1762's uv-sync-locked.test.sh guards that every `uv sync` call
# site inside _skeletons/**/.github/workflows/** carries `--locked`, so a
# scaffolded plugin/sibling repo's OWN CI refuses to silently re-resolve a
# drifted lock. That protects every repo scaffolded FROM the skeleton. It
# does nothing for the skeleton itself: `--locked` only fires when something
# runs `uv sync` against it, and nothing in biffo-template's own CI ever
# does -- the skeletons are copied, not installed, by this repo's pipeline
# (`biffo sibling create` / `biffo plugin create` / core-manifest
# distribution). So a hand-edited _skeletons/plugin-template/pyproject.toml
# with no matching `uv lock` run could sit drifted in THIS repo indefinitely,
# invisible until the first repo scaffolded from it hit the guard #1762 just
# added -- which reports failure in a DIFFERENT repo's CI, potentially days
# or weeks after the drift-causing commit landed here.
#
# This guard closes that gap upstream: it runs `uv lock --check` against
# each skeleton's own lockfile, in the skeleton's own directory, in
# biffo-template's own CI -- so drift is caught before it is ever
# distributed via `biffo core upgrade`, `sibling create` or `plugin create`,
# not after.
#
# ## Discovery, not enumeration
#
# The two lockfiles are found by globbing `_skeletons/**/uv.lock` rather
# than naming `_skeletons/plugin-template/uv.lock` and
# `_skeletons/sibling-template/services/api/uv.lock` by hand -- the same
# "derived denominator" discipline uv-sync-locked.test.sh uses for workflow
# call sites, for the same reason: a third skeleton, or a skeleton project
# moving to a new path, must not be free to sit unchecked because nobody
# remembered to update a hand-written list here.
#
# ## Fail-closed requirements
#
# - Zero uv.lock files found under _skeletons/ is a FAILURE, not a vacuous
#   pass -- the exact shape of guard the estate has repeatedly needed
#   reminding not to build (see uv-sync-locked.test.sh, guard-self-test-
#   wiring.sh).
# - A uv.lock with no sibling pyproject.toml in the same directory is a
#   FAILURE -- it cannot be checked and "cannot check" is not "checked ok".
# - `uv lock --check` exiting non-zero for a lockfile is a FAILURE, reported
#   by path so the fix is a one-line `cd <dir> && uv lock`, not a hunt.
#
# This is a *.test.sh guard, auto-discovered and run by
# scripts/guard-self-test-wiring.sh if nothing else wires it into CI first
# (see that script's own docstring for why an unwired guard still runs
# rather than silently contributing nothing) -- the same mechanism
# uv-sync-locked.test.sh itself relies on, verified live in dev CI per the
# #1731 prosecutor verdict.
#
# Requires `uv` on PATH (the CI job this runs in already sets it up via
# astral-sh/setup-uv, ahead of the root workspace's own `uv sync --locked`
# step).
#
# POSIX sh; validated with BOTH `dash -n` and `bash -n` (no bashisms used).
#
# Run: sh scripts/skeleton-lockfile-freshness.test.sh

set -u

SKELETON_DIR="_skeletons"

if [ ! -d "$SKELETON_DIR" ]; then
  echo "FAIL: ${SKELETON_DIR}/ does not exist -- the guard has nothing to scan, which is itself the failure this exists to catch." >&2
  exit 1
fi

lockfiles=$(find "$SKELETON_DIR" -name 'uv.lock' -type f | sort)

if [ -z "$lockfiles" ]; then
  echo "FAIL: found 0 uv.lock files under ${SKELETON_DIR}/ -- the glob matched nothing." >&2
  exit 1
fi

repo_root=$(pwd)
checked=0
failures=0

for lock in $lockfiles; do
  checked=$((checked + 1))
  dir=$(dirname "$lock")

  if [ ! -f "$dir/pyproject.toml" ]; then
    echo "FAIL: ${lock} has no sibling pyproject.toml in ${dir} -- cannot verify freshness." >&2
    failures=$((failures + 1))
    continue
  fi

  echo "Checking ${lock} against ${dir}/pyproject.toml ..."
  if ! (cd "$dir" && uv lock --check); then
    echo "FAIL: ${lock} is stale relative to ${dir}/pyproject.toml -- run 'uv lock' in ${dir} and commit the result." >&2
    failures=$((failures + 1))
  fi
  cd "$repo_root" || exit 1
done

echo
echo "skeleton-lockfile-freshness scan: ${checked} uv.lock file(s) checked under ${SKELETON_DIR}/, ${failures} stale."

if [ "$failures" -gt 0 ]; then
  exit 1
fi

exit 0
