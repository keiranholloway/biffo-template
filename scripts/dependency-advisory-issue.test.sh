#!/usr/bin/env sh
#
# Proves scripts/dependency-advisory-issue.sh (#2040) is idempotent: calling
# it TWICE against the same seeded advisory finding opens exactly ONE issue
# — the second call finds the first call's issue by its exact title and
# comments on it, rather than opening a second. This is the "Done when"
# bullet's own idempotence proof for the scheduled scan, run locally against
# a stubbed `gh` rather than a live GitHub repo.
#
# Also proves the companion case: two DIFFERENT advisory IDs each get their
# own issue (the per-advisory design is not accidentally collapsing every
# finding into one).
#
# Run: sh scripts/dependency-advisory-issue.test.sh

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TARGET="$SCRIPT_DIR/dependency-advisory-issue.sh"

STUB_DIR=$(mktemp -d)
STATE_DIR=$(mktemp -d)
trap 'rm -rf "$STUB_DIR" "$STATE_DIR"' EXIT

FAILURES=0

# --- gh stub -----------------------------------------------------------------
# Tracks open issues in $STATE_DIR as one file per issue: the filename is a
# sequence number, the content is the title. `issue list --json number,title`
# emits them as JSON; `issue create` allocates the next number and a fake
# URL; `issue comment` appends to a per-issue comment-count file so the test
# can assert a comment actually happened rather than merely not-a-second-create.
cat > "$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env sh
case "$1 $2" in
  "issue list")
    # Real `gh` applies --jq itself server-side/client-side and returns the
    # FILTERED result -- the target script relies on that (same as every
    # other scheduled-report workflow in this repo). This stub emits the raw
    # JSON array, then applies the SAME --jq expression via the real `jq`
    # binary, so the filtering behaviour under test is real jq, not a
    # reimplementation of gh's own --jq flag.
    jq_expr=""
    shift 2
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --jq) jq_expr="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    raw="["
    first=1
    for f in "$STATE_DIR_ENV"/issue-*.title; do
      [ -f "$f" ] || continue
      num=$(basename "$f" .title)
      num=${num#issue-}
      title=$(cat "$f")
      [ "$first" -eq 1 ] || raw="${raw},"
      first=0
      # Titles in this fixture never contain a `"` or backslash, so plain
      # quoting is safe -- this stub only needs to round-trip what this
      # test itself writes, not arbitrary GitHub issue titles.
      raw="${raw}{\"number\":${num},\"title\":\"${title}\"}"
    done
    raw="${raw}]"
    if [ -n "$jq_expr" ]; then
      printf '%s' "$raw" | jq -r "$jq_expr"
    else
      printf '%s' "$raw"
    fi
    ;;
  "issue create")
    shift 2
    title=""
    body=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --title) title="$2"; shift 2 ;;
        --body) body="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    next=$(cat "$STATE_DIR_ENV/next" 2>/dev/null || echo 1)
    printf '%s' "$title" > "$STATE_DIR_ENV/issue-${next}.title"
    printf '%s' "$body" > "$STATE_DIR_ENV/issue-${next}.body"
    echo 0 > "$STATE_DIR_ENV/issue-${next}.comments"
    echo $((next + 1)) > "$STATE_DIR_ENV/next"
    echo "https://github.com/keiranholloway/biffo-template/issues/${next}"
    ;;
  "issue comment")
    shift 2
    num="$1"
    count=$(cat "$STATE_DIR_ENV/issue-${num}.comments" 2>/dev/null || echo 0)
    echo $((count + 1)) > "$STATE_DIR_ENV/issue-${num}.comments"
    ;;
  *)
    echo "gh stub: unexpected invocation: $*" >&2
    exit 99
    ;;
esac
STUB
chmod +x "$STUB_DIR/gh"

# `jq` is used for real: it is exactly what the target script depends on for
# the exact-title filter, and the stub's own JSON above is real, valid JSON
# (plain quoting is safe here -- see the stub's own comment on why).
if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: jq not on PATH -- cannot exercise the real filter this script depends on."
  exit 0
fi

_reset_state() {
  rm -f "$STATE_DIR"/issue-*.title "$STATE_DIR"/issue-*.body "$STATE_DIR"/issue-*.comments "$STATE_DIR/next"
}

_run() {
  # $1 ecosystem, $2 advisory id, $3 package, $4 severity, $5 run url
  (
    PATH="$STUB_DIR:$PATH"
    STATE_DIR_ENV="$STATE_DIR"
    export PATH STATE_DIR_ENV
    sh "$TARGET" "$1" "$2" "$3" "$4" "$5"
  )
}

_issue_count() {
  find "$STATE_DIR" -maxdepth 1 -name 'issue-*.title' | wc -l | tr -d ' '
}

# ==============================================================================
# 1. Idempotence: the same advisory, seeded twice, produces exactly ONE issue.
# ==============================================================================
_reset_state
out1=$(_run npm GHSA-p293-qw3h-jr36 next high "https://example/run/1")
count_after_first=$(_issue_count)
out2=$(_run npm GHSA-p293-qw3h-jr36 next high "https://example/run/2")
count_after_second=$(_issue_count)

if printf '%s' "$out1" | grep -q '^created: #1 '; then
  echo "PASS: first run creates issue #1"
else
  echo "FAIL: first run did not create issue #1 -- got: $out1"
  FAILURES=$((FAILURES + 1))
fi

if [ "$count_after_first" -eq 1 ]; then
  echo "PASS: exactly 1 issue exists after the first run"
else
  echo "FAIL: expected 1 issue after the first run, found $count_after_first"
  FAILURES=$((FAILURES + 1))
fi

if printf '%s' "$out2" | grep -q '^commented: #1 '; then
  echo "PASS: second run against the SAME advisory comments on #1 rather than creating"
else
  echo "FAIL: second run did not comment on the existing issue -- got: $out2"
  FAILURES=$((FAILURES + 1))
fi

if [ "$count_after_second" -eq 1 ]; then
  echo "PASS: still exactly 1 issue after the second run -- idempotent, no duplicate (#2040)"
else
  echo "FAIL: expected still 1 issue after the second run, found $count_after_second -- NOT idempotent"
  FAILURES=$((FAILURES + 1))
fi

comments=$(cat "$STATE_DIR/issue-1.comments" 2>/dev/null || echo 0)
if [ "$comments" -eq 1 ]; then
  echo "PASS: the second run recorded a real comment on #1 (not a silent no-op)"
else
  echo "FAIL: expected 1 comment recorded on #1, found $comments"
  FAILURES=$((FAILURES + 1))
fi

# ==============================================================================
# 2. Two DIFFERENT advisories each get their OWN issue -- the per-advisory
#    design is not silently collapsing distinct findings into one.
# ==============================================================================
_reset_state
_run npm GHSA-p293-qw3h-jr36 next high "https://example/run/3" >/dev/null
_run npm GHSA-82fw-gwwq-j7x9 vitest high "https://example/run/3" >/dev/null
count_two=$(_issue_count)
if [ "$count_two" -eq 2 ]; then
  echo "PASS: two distinct advisories in the same run produce two distinct issues"
else
  echo "FAIL: expected 2 issues for 2 distinct advisories, found $count_two"
  FAILURES=$((FAILURES + 1))
fi

# ==============================================================================
# 3. Missing gh / jq fails closed (exit 2), never silently skips filing.
# ==============================================================================
_reset_state
EMPTY_PATH_DIR=$(mktemp -d)
SH_BIN=$(command -v sh)
(
  PATH="$EMPTY_PATH_DIR"
  export PATH
  # Absolute path to the interpreter: PATH is deliberately empty of
  # everything (including gh/jq, what this case tests) so `sh` itself must
  # be invoked directly rather than resolved via lookup.
  "$SH_BIN" "$TARGET" npm GHSA-x x high "https://example/run/4"
)
rc=$?
rmdir "$EMPTY_PATH_DIR"
if [ "$rc" -eq 2 ]; then
  echo "PASS: missing gh/jq on PATH fails closed (exit 2)"
else
  echo "FAIL: expected exit 2 with no gh/jq on PATH, got $rc"
  FAILURES=$((FAILURES + 1))
fi

# ==============================================================================
# 4. Wrong argument count fails closed (exit 2) rather than filing garbage.
# ==============================================================================
(
  PATH="$STUB_DIR:$PATH"
  export PATH
  sh "$TARGET" npm GHSA-x
)
rc=$?
if [ "$rc" -eq 2 ]; then
  echo "PASS: wrong argument count fails closed (exit 2)"
else
  echo "FAIL: expected exit 2 on wrong argument count, got $rc"
  FAILURES=$((FAILURES + 1))
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "dependency-advisory-issue.test.sh: all checks passed."
  exit 0
else
  echo "dependency-advisory-issue.test.sh: $FAILURES check(s) failed."
  exit 1
fi
