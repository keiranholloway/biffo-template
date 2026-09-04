#!/usr/bin/env sh
#
# Proves js-dependency-audit.sh (#1874) audits its discovered pnpm-lock.yaml
# trees IN PARALLEL, and that backgrounding the per-tree `audit_dir` calls did
# not change any of the aggregation semantics the sequential version had.
#
# The incident this guards against: a real CI run (tabsii-platform PR #1326)
# audited 4 lockfile trees one after another, each a real network round-trip
# to registry.npmjs.org with its own retry/backoff, and the step alone took
# 15m21s -- blowing the JS CI job's 20-minute cap mid-way through ~9 other
# required guard steps that never got to run. #1874 backgrounds each
# `audit_dir` invocation so the trees overlap instead of serialising, and has
# each invocation write its one-word verdict (ok/fail/inconclusive) to its own
# temp file, because a backgrounded call is a forked subshell that cannot
# mutate the parent's counters directly.
#
# Builds a real, tiny, throwaway git repo under mktemp (never a copy of THIS
# repo's own worktree/object store -- see AGENTS.md's "never create a git
# worktree ... under /tmp" warning, which is about exactly that, not about a
# handful of scaffolded files) with three real pnpm-lock.yaml trees: the
# workspace root and two vendored subdirectories, mirroring this repo's own
# shape (root + two `_skeletons/**` trees). `pnpm` is stubbed on PATH -- no
# network, no real npm registry -- but `jq`, `git` and `find` are the real
# system tools, exactly what the target script itself depends on.
#
# Run: sh scripts/js-dependency-audit-parallel.test.sh

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TARGET="$SCRIPT_DIR/js-dependency-audit.sh"

REPO_DIR=$(mktemp -d)
STUB_DIR=$(mktemp -d)
TMPROOT_DIR=$(mktemp -d)
OUT_FILE=$(mktemp)
trap 'rm -rf "$REPO_DIR" "$STUB_DIR" "$TMPROOT_DIR"; rm -f "$OUT_FILE"' EXIT

FAILURES=0

# --- repo scaffolding --------------------------------------------------------
# Workspace root + two vendored trees, same shape as this repo's own
# `.` / `_skeletons/plugin-template/web-admin` /
# `_skeletons/sibling-template/apps/frontend`.
_scaffold_repo() {
  rm -rf "$REPO_DIR"
  mkdir -p "$REPO_DIR/vendor-a" "$REPO_DIR/vendor-b"
  (
    cd "$REPO_DIR" \
      && git init -q \
      && git config user.email test@example.com \
      && git config user.name "Test"
  )
  echo "lockfileVersion: '9.0'" >"$REPO_DIR/pnpm-lock.yaml"
  echo "lockfileVersion: '9.0'" >"$REPO_DIR/vendor-a/pnpm-lock.yaml"
  echo "lockfileVersion: '9.0'" >"$REPO_DIR/vendor-b/pnpm-lock.yaml"
  ( cd "$REPO_DIR" && git add -A && git commit -q -m base )
}

# --- pnpm stub ---------------------------------------------------------------
# Selected by cwd (the tree being audited), driven entirely by files the test
# stages under $STUB_DIR before each `_run`. Logs its own invocation (cwd +
# args) so the --ignore-workspace flag logic can be checked, and can be told
# to sleep so the parallel-vs-sequential timing case has something to measure.
cat > "$STUB_DIR/pnpm" <<'STUB'
#!/usr/bin/env sh
cwd=$(pwd -P)
safe=$(printf '%s' "$cwd" | tr '/' '_')
printf '%s\n' "$*" >>"$STUB_DIR_ENV/invocations-$safe"

if [ -f "$STUB_DIR_ENV/sleep-seconds" ]; then
  sleep "$(cat "$STUB_DIR_ENV/sleep-seconds")"
fi

output_file="$STUB_DIR_ENV/output-$safe"
if [ -f "$output_file" ]; then
  cat "$output_file"
else
  cat "$STUB_DIR_ENV/output-default"
fi
STUB
chmod +x "$STUB_DIR/pnpm"

_clean_json() {
  cat <<JSON
{"metadata":{"vulnerabilities":{"critical":0,"high":0,"moderate":0,"low":0},"totalDependencies":10}}
JSON
}

_fail_json() {
  cat <<JSON
{"metadata":{"vulnerabilities":{"critical":0,"high":2,"moderate":0,"low":0},"totalDependencies":10}}
JSON
}

_reset_stub_state() {
  rm -f "$STUB_DIR"/invocations-* "$STUB_DIR"/output-* "$STUB_DIR/sleep-seconds"
  _clean_json >"$STUB_DIR/output-default"
}

# --- runner -------------------------------------------------------------------
_run() {
  (
    cd "$REPO_DIR" || exit 97
    PATH="$STUB_DIR:$PATH"
    STUB_DIR_ENV="$STUB_DIR"
    TMPDIR="$TMPROOT_DIR"
    export PATH STUB_DIR_ENV TMPDIR
    sh "$TARGET"
  ) >"$OUT_FILE" 2>&1
  LAST_RC=$?
}

_assert_exit() {
  name=$1
  expected=$2
  if [ "$LAST_RC" -eq "$expected" ]; then
    echo "PASS: $name (exit $LAST_RC)"
  else
    echo "FAIL: $name -- expected exit $expected, got $LAST_RC"
    echo "--- output ---"
    cat "$OUT_FILE"
    echo "--------------"
    FAILURES=$((FAILURES + 1))
  fi
}

_assert_output_contains() {
  name=$1
  needle=$2
  if grep -qF -- "$needle" "$OUT_FILE"; then
    echo "PASS: $name mentions '$needle'"
  else
    echo "FAIL: $name -- expected output to mention '$needle'"
    echo "--- output ---"
    cat "$OUT_FILE"
    echo "--------------"
    FAILURES=$((FAILURES + 1))
  fi
}

# ==============================================================================
# Case table (must-NOT-block first, then must-block, then the parallel-specific
# cases), each run against the real target script -- not a reimplementation.
# ==============================================================================

# 1. All three trees clean -> exits 0, discovers and audits all three, prints
#    the workspace label only for the root tree.
_scaffold_repo
_reset_stub_state
_run
_assert_exit "all clean" 0
_assert_output_contains "discovery lists workspace root" "- . (workspace)"
_assert_output_contains "discovery lists vendor-a" "- vendor-a"
_assert_output_contains "discovery lists vendor-b" "- vendor-b"
_assert_output_contains "final summary" "audited 3 tree(s), 0 blocking findings"

# 2. One vendored tree has a real high-severity finding, others clean -> must
#    still block (exit 1), and the workspace's own clean tree must still be
#    audited and reported (a background failure elsewhere must not suppress
#    another tree's own result).
_scaffold_repo
_reset_stub_state
safe_a=$(printf '%s' "$REPO_DIR/vendor-a" | tr '/' '_')
_fail_json >"$STUB_DIR/output-$safe_a"
_run
_assert_exit "one tree fails -- blocks overall" 1
_assert_output_contains "workspace still reported despite sibling failure" "pnpm audit (workspace: .): 0 critical, 0 high"
_assert_output_contains "failing tree named" "2 high advisory(ies)"

# 3. One vendored tree persistently returns unparseable output (simulating a
#    registry hiccup), others clean -> INCONCLUSIVE-only, exits 2 (never 0 or
#    1), and the other two trees' clean results still print.
_scaffold_repo
_reset_stub_state
safe_b=$(printf '%s' "$REPO_DIR/vendor-b" | tr '/' '_')
echo 'not valid json' >"$STUB_DIR/output-$safe_b"
_run
_assert_exit "one tree inconclusive-only -- exits 2" 2
_assert_output_contains "inconclusive tree named" "audit could not run after 3 attempts"
_assert_output_contains "workspace still reported despite sibling inconclusive" "pnpm audit (workspace: .): 0 critical, 0 high"

# 4. Both a real failure AND an inconclusive tree in the same run -- a real
#    finding must still take priority over "could not tell" (exit 1, not 2),
#    exactly like the pre-parallel sequential version (failed is checked
#    before inconclusive).
_scaffold_repo
_reset_stub_state
_fail_json >"$STUB_DIR/output-$safe_a"
echo 'not valid json' >"$STUB_DIR/output-$safe_b"
_run
_assert_exit "fail + inconclusive together -- fail wins (exit 1)" 1

# 5. --ignore-workspace flag logic: the workspace root's invocation must NOT
#    carry it, every vendored tree's invocation MUST.
_scaffold_repo
_reset_stub_state
safe_root=$(printf '%s' "$REPO_DIR" | tr '/' '_')
_run
if grep -q -- '--ignore-workspace' "$STUB_DIR/invocations-$safe_root" 2>/dev/null; then
  echo "FAIL: workspace root invocation carries --ignore-workspace"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: workspace root invocation has no --ignore-workspace"
fi
if grep -q -- '--ignore-workspace' "$STUB_DIR/invocations-$safe_a" 2>/dev/null &&
  grep -q -- '--ignore-workspace' "$STUB_DIR/invocations-$safe_b" 2>/dev/null; then
  echo "PASS: both vendored trees carry --ignore-workspace"
else
  echo "FAIL: a vendored tree is missing --ignore-workspace"
  FAILURES=$((FAILURES + 1))
fi

# 6. Zero discovery still fails CLOSED (exit 2), unaffected by the parallel
#    rewrite -- a bare git repo with no pnpm-lock.yaml at all.
rm -rf "$REPO_DIR"
mkdir -p "$REPO_DIR"
( cd "$REPO_DIR" && git init -q && git config user.email test@example.com && git config user.name "Test" )
_reset_stub_state
_run
_assert_exit "zero discovery -- fails closed" 2

# 7. Parallelism actually happens: three trees each take ~2s (simulating the
#    real network round-trip's floor). Sequential would cost ~6s+; run in
#    parallel it must finish well under that -- proves the trees genuinely
#    overlap rather than merely being *labelled* backgrounded.
_scaffold_repo
_reset_stub_state
echo 2 >"$STUB_DIR/sleep-seconds"
start=$(date +%s)
_run
end=$(date +%s)
elapsed=$((end - start))
_assert_exit "parallel timing case -- still all clean" 0
if [ "$elapsed" -lt 5 ]; then
  echo "PASS: 3 trees x ~2s each finished in ${elapsed}s (< 5s) -- ran in parallel, not serially"
else
  echo "FAIL: 3 trees x ~2s each took ${elapsed}s (>= 5s) -- looks serial, not parallel"
  FAILURES=$((FAILURES + 1))
fi

# 8. Cleanup: the script's own result-file temp directory (created under
#    $TMPDIR, which this test points at $TMPROOT_DIR) must not survive the
#    run -- the EXIT/HUP/INT/TERM trap must have removed it.
leftover=$(find "$TMPROOT_DIR" -mindepth 1 -maxdepth 1 2>/dev/null)
if [ -z "$leftover" ]; then
  echo "PASS: no leftover temp directory under \$TMPDIR after the run"
else
  echo "FAIL: leftover temp entries under \$TMPDIR: $leftover"
  FAILURES=$((FAILURES + 1))
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "js-dependency-audit-parallel.test.sh: all checks passed."
  exit 0
else
  echo "js-dependency-audit-parallel.test.sh: $FAILURES check(s) failed."
  exit 1
fi
