#!/usr/bin/env sh
#
# Proves the class #1886 exists to close: DDL module-number allocation must
# not hand out the same number to two concurrent branches. Two halves --
#
#   1. FAIL-FIRST: the OLD `ls db/imports/<name>/ | tail` approach, raced
#      exactly as concurrent branches actually race it, DOES collide.
#   2. The NEW allocator (scripts/allocate-module-number.sh), raced the same
#      way against the same starting state, DOES NOT.
#
# Both halves race real `git` processes against a real (throwaway, local)
# bare git repository -- no mocking of git itself, because the property
# under test ("can two racers ever land on the same ref/number") is a
# property of git's own remote ref-update semantics, and a mock would just
# assert whatever the mock author assumed rather than what git actually
# does. This is also how design bug #1 below was FOUND, not merely how it
# is now demonstrated fixed: an earlier version of allocate-module-number.sh
# pushed the caller's own HEAD sha as the lock value, which is safe when
# racers have distinct commits but produces a silent git no-op ("Everything
# up-to-date", exit 0) -- not a rejection -- when two racers share an
# identical HEAD, which is the ordinary case for two worktrees freshly
# branched from the same origin/dev tip. Racing ten real invocations that
# all shared one HEAD reproduced duplicate allocations before the fix
# (unique-lock-object commits, see the script's own comments); this test
# freezes that scenario so it cannot regress silently.
#
# Uses local bare repos under THIS repo's own tree (never /tmp -- a bare
# repo used only for tiny ref pushes is not the "copy a whole working tree
# with a full .git object store" case that hazard is about, but there is no
# reason to risk it when a repo-local scratch directory costs nothing and
# is already the pattern this estate uses for worktrees).
#
# Run: sh scripts/allocate-module-number.test.sh
# Exit 0 = every property below holds. Exit 1 = a regression.

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
ALLOCATOR="$REPO_ROOT/scripts/allocate-module-number.sh"

WORK=$(mktemp -d "$REPO_ROOT/.alloc-module-number-test-XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM

fail=0
report() {
  echo "FAIL: $1" >&2
  fail=1
}

# Fast, deterministic retries -- these tests care about correctness under
# real contention, not about rehearsing the full production backoff.
export BIFFO_ALLOC_MAX_ATTEMPTS=60
export BIFFO_ALLOC_RETRY_SLEEP=0.1

# --- Fixture: a bare "remote" seeded with a `trunk` branch (deliberately
# not `dev` -- this workstation's own git hooks refuse a direct push to any
# branch literally named `dev`, including inside a throwaway local fixture
# that has nothing to do with the real integration branch) holding a small
# db/imports/<name>/ tree. `--base trunk` points the allocator at it. -----
make_fixture() {
  bare="$1"
  seed="$2"
  import_name="$3"
  shift 3

  mkdir -p "$bare"
  git init --quiet --bare "$bare"

  mkdir -p "$seed/db/imports/$import_name"
  ( cd "$seed" &&
    git init --quiet &&
    git checkout --quiet -b trunk &&
    for f in "$@"; do
      : > "db/imports/$import_name/$f"
    done &&
    git add -A &&
    # An empty db/imports/<name>/ (the "no existing modules" fixture) stages
    # nothing -- git does not track empty directories -- so `--allow-empty`
    # is needed to still produce a commit (and therefore a pushed `trunk`)
    # rather than failing the whole `&&` chain silently.
    git -c user.email=t@example.invalid -c user.name=t commit --quiet --allow-empty -m seed &&
    git remote add origin "$bare" &&
    git push --quiet --no-verify origin trunk
  )
}

# The defect this whole file exists to close: read-then-decide with no
# coordination. Mirrors the real convention exactly (`ls ... | tail`).
naive_next_number() {
  fixture_seed="$1"
  ( cd "$fixture_seed" &&
    git fetch --quiet origin trunk &&
    git ls-tree -r --name-only origin/trunk -- "db/imports/demo/" 2>/dev/null |
      awk -F'/' '{print $NF}' | sort |
      awk -F'_' '{print $1}' | sort -n | tail -1 |
      awk '{printf "%03d\n", $1 + 1}'
  )
}

# =============================================================================
# 1. FAIL-FIRST: the naive approach collides under real concurrency.
# =============================================================================

naive_bare="$WORK/naive-bare.git"
naive_seed="$WORK/naive-seed"
make_fixture "$naive_bare" "$naive_seed" demo 010_a.sql

naive_out_dir="$WORK/naive-out"
mkdir -p "$naive_out_dir"

# Ten independent checkouts of the SAME starting state -- exactly what ten
# concurrent branches look like before any of them has committed a module
# file of their own. None of them coordinate, so none of them can see any
# other's read.
i=1
while [ "$i" -le 10 ]; do
  clone="$WORK/naive-clone-$i"
  git clone --quiet "$naive_bare" "$clone"
  i=$((i + 1))
done

pids=""
i=1
while [ "$i" -le 10 ]; do
  ( naive_next_number "$WORK/naive-clone-$i" > "$naive_out_dir/$i.out" ) &
  pids="$pids $!"
  i=$((i + 1))
done
wait $pids

naive_values=$(cat "$naive_out_dir"/*.out)
naive_unique=$(printf '%s\n' "$naive_values" | sort -u | wc -l | tr -d ' ')

echo "naive tail-of-ls: 10 racers produced $naive_unique unique number(s) (values: $(printf '%s' "$naive_values" | tr '\n' ' '))"

if [ "$naive_unique" -eq 10 ]; then
  report "the naive tail-of-ls approach did NOT collide under this scenario -- the fixture no longer reproduces the defect #1886 is about, so it is not proving what this file claims."
fi

# =============================================================================
# 2. The new allocator does not collide under the identical scenario.
# =============================================================================

new_bare="$WORK/new-bare.git"
new_seed="$WORK/new-seed"
make_fixture "$new_bare" "$new_seed" demo 010_a.sql

# All ten racers run from the SAME worktree (the real script's own repo
# checkout), sharing an identical HEAD -- the scenario that broke the first
# version of this allocator (see the file header). This is deliberately
# harder than using ten distinct clones.
new_out_dir="$WORK/new-out"
mkdir -p "$new_out_dir"

pids=""
i=1
while [ "$i" -le 10 ]; do
  (
    out=$(sh "$ALLOCATOR" demo --git-remote "$new_bare" --base trunk 2>"$new_out_dir/$i.err")
    rc=$?
    # Trailing newline matters: these files are later concatenated with
    # `cat *.out` to get one value per line. Without it, two racers' outputs
    # with no separator between them read back as a single fused number and
    # `sort -u` silently under-counts -- caught by this test's own first
    # real run, which is why it is called out rather than left implicit.
    printf '%s\n' "$out" > "$new_out_dir/$i.out"
    echo "$rc" > "$new_out_dir/$i.rc"
  ) &
  pids="$pids $!"
  i=$((i + 1))
done
wait $pids

new_bad_rc=0
i=1
while [ "$i" -le 10 ]; do
  rc=$(cat "$new_out_dir/$i.rc")
  if [ "$rc" != "0" ]; then
    new_bad_rc=$((new_bad_rc + 1))
    echo "  racer $i exited $rc: $(cat "$new_out_dir/$i.err")" >&2
  fi
  i=$((i + 1))
done

if [ "$new_bad_rc" -ne 0 ]; then
  report "$new_bad_rc of 10 concurrent allocate-module-number.sh invocations did not exit 0 -- expected all ten to succeed (contention should cost retries, not failures) at BIFFO_ALLOC_MAX_ATTEMPTS=$BIFFO_ALLOC_MAX_ATTEMPTS."
fi

new_values=$(cat "$new_out_dir"/*.out)
new_unique=$(printf '%s\n' "$new_values" | sort -u | wc -l | tr -d ' ')
new_count=$(printf '%s\n' "$new_values" | grep -c '^[0-9][0-9]*$' || true)

echo "new allocator: 10 racers produced $new_unique unique number(s) from $new_count non-empty outputs (values: $(printf '%s' "$new_values" | tr '\n' ' '))"

if [ "$new_unique" -ne 10 ]; then
  report "the new allocator handed out only $new_unique unique number(s) across 10 concurrent racers sharing an identical HEAD -- expected 10. This is the exact defect #1886 exists to remove."
fi

# =============================================================================
# 3. Single-invocation behaviour.
# =============================================================================

# Empty base -> 001.
empty_bare="$WORK/empty-bare.git"
empty_seed="$WORK/empty-seed"
make_fixture "$empty_bare" "$empty_seed" demo
out=$(sh "$ALLOCATOR" demo --git-remote "$empty_bare" --base trunk 2>/dev/null)
if [ "$out" != "001" ]; then
  report "empty db/imports/demo/ expected allocation '001', got '$out'"
fi

# Existing numbers -> one past the highest, padding preserved.
padded_bare="$WORK/padded-bare.git"
padded_seed="$WORK/padded-seed"
make_fixture "$padded_bare" "$padded_seed" demo 009_a.sql
out=$(sh "$ALLOCATOR" demo --git-remote "$padded_bare" --base trunk 2>/dev/null)
if [ "$out" != "010" ]; then
  report "base with only '009' expected allocation '010', got '$out'"
fi

wide_bare="$WORK/wide-bare.git"
wide_seed="$WORK/wide-seed"
make_fixture "$wide_bare" "$wide_seed" demo 099_a.sql
out=$(sh "$ALLOCATOR" demo --git-remote "$wide_bare" --base trunk 2>/dev/null)
if [ "$out" != "100" ]; then
  report "base with only '099' expected allocation '100' (width grows), got '$out'"
fi

# A number already reserved (lock ref exists, no file yet) is skipped.
skip_bare="$WORK/skip-bare.git"
skip_seed="$WORK/skip-seed"
make_fixture "$skip_bare" "$skip_seed" demo 010_a.sql
( cd "$skip_seed" &&
  empty_tree=$(git hash-object -w -t tree /dev/null) &&
  lock_sha=$(git commit-tree "$empty_tree" -m "pre-existing reservation") &&
  git push --quiet --no-verify origin "$lock_sha:refs/biffo-module-locks/demo/011"
)
out=$(sh "$ALLOCATOR" demo --git-remote "$skip_bare" --base trunk 2>/dev/null)
if [ "$out" != "012" ]; then
  report "with '010' on disk and '011' already lock-reserved (no file), expected allocation '012', got '$out'"
fi

# Unreadable remote: refuses rather than guessing, exit 2 (never a pass).
out=$(sh "$ALLOCATOR" demo --git-remote "$WORK/does-not-exist.git" --base trunk 2>&1)
rc=$?
if [ "$rc" != "2" ]; then
  report "an unreachable remote expected exit 2 ('cannot tell'), got exit $rc (output: $out)"
fi

# Unrecognized option: usage error, exit 1.
out=$(sh "$ALLOCATOR" demo --bogus-flag 2>&1)
rc=$?
if [ "$rc" != "1" ]; then
  report "an unrecognized option expected exit 1, got exit $rc (output: $out)"
fi

# db/imports/ with more than one subdirectory and no explicit name: refused,
# not guessed.
ambiguous_dir="$WORK/ambiguous"
mkdir -p "$ambiguous_dir/db/imports/one" "$ambiguous_dir/db/imports/two"
( cd "$ambiguous_dir" &&
  git init --quiet &&
  git -c user.email=t@example.invalid -c user.name=t commit --quiet --allow-empty -m x
)
out=$(cd "$ambiguous_dir" && sh "$ALLOCATOR" --git-remote "$empty_bare" --base trunk 2>&1)
rc=$?
if [ "$rc" != "1" ]; then
  report "ambiguous db/imports/ (two subdirectories, no explicit name) expected exit 1, got exit $rc (output: $out)"
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "PASS: the naive tail-of-ls approach collides under real concurrency, the new"
echo "      allocator does not (verified against a real git remote, not a mock),"
echo "      and single-invocation behaviour (padding, skip-locked, unreadable"
echo "      remote, bad usage, ambiguous import dir) all hold."
exit 0
