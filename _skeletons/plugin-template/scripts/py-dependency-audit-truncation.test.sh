#!/usr/bin/env sh
#
# Proves py-dependency-audit.sh (#1995) no longer pipes a large writer
# directly into `head -c N`. `head -c` closes its read end the instant it
# has enough bytes; if the upstream write is still in flight when that
# happens, the writer gets SIGPIPE. Confirmed live via `strace -f` against
# the real script's line-234 command (a >4000-byte jq-filtered finding
# dump): `jq`, forked from that exact pipeline, was silently killed by
# SIGPIPE the instant `head -c 4000` closed early on a large payload. That
# is the general mechanism #1995 reports. The CI-only "printf: printf: I/O
# error" wording it also reports needs dash's own builtin `printf` to be the
# process still writing at that instant -- a narrower timing window this
# workstation's dash/kernel did not reproduce across repeated attempts up to
# a 94MB payload (see the PR body for the full trail). The issue's own
# citation -- a real, timestamped CI job log
# (biffo-plugin-idea-scout PR #126) -- is the evidence for that exact
# wording; this file does not re-derive it.
#
# ## Case 1: deterministic proof of the pipe-shape defect and its fix
#
# Removes scheduling luck from the underlying mechanism instead of racing
# for it: the writer sleeps briefly before writing, so a reader that exits
# immediately is GUARANTEED to have already closed its read end before the
# writer's first write() call. Shows the OLD shape (writer piped straight
# into a reader that may close early) reliably kills the writer before it
# can even report its own exit code, and the NEW shape this fix uses (write
# to a regular file first, read the FINISHED file) never does, regardless of
# payload size or timing -- because there is no concurrent writer left for a
# reader to break.
#
# ## Case 2: the real script, end to end, with a >4000-byte finding
#
# Reuses the uv-stub harness from py-dependency-audit-classification.test.sh
# to run the actual target script against a finding payload whose filtered
# JSON exceeds the 4000-byte truncation threshold, and checks the
# classification/exit-code behaviour and the truncated dump are unaffected
# by the fix.
#
# Run: sh scripts/py-dependency-audit-truncation.test.sh

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TARGET="$SCRIPT_DIR/py-dependency-audit.sh"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

FAILURES=0

# ============================================================================
# Case 0: the target script actually uses the safe shape
# ============================================================================
#
# Case 1 below proves the OLD shape is unsafe and the NEW shape is not, as a
# standalone fact about pipes -- it does not read $TARGET, so on its own it
# would not notice a regression that reverted the real script back to the
# vulnerable pattern. This case closes that gap directly against the file.

if grep -Eq "jq '\[\.dependencies\[\] \| select\(\.vulns \| length > 0\)\]' 2>/dev/null \| head -c" "$TARGET"; then
  echo "FAIL: $TARGET pipes the vulns dump straight from jq into head -c again -- this is the exact shape #1995 reports"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: $TARGET does not pipe the vulns dump straight from jq into head -c"
fi

if grep -q 'head -c 4000 "\$dump_file"' "$TARGET"; then
  echo "PASS: $TARGET truncates from a finished regular file, not a live pipe"
else
  echo "FAIL: $TARGET no longer truncates from a regular file -- expected a 'head -c 4000 \"\$dump_file\"' line"
  FAILURES=$((FAILURES + 1))
fi

# ============================================================================
# Case 1: deterministic pipe-shape proof
# ============================================================================

# 2MB of 'a' -- comfortably over the 64KiB Linux pipe buffer, so a writer
# emitting it in one shot cannot fit in the buffer and must block on a
# reader that may already be gone.
PAYLOAD="$(head -c 2000000 /dev/zero | tr '\0' 'a')"

# OLD shape: writer piped straight into an early-closing reader (`{ : ; }`
# reads nothing and exits immediately). The `sleep 0.5` guarantees the
# reader has already exited and closed its read end before the writer's
# first write() call -- this is not racing the scheduler, it is removing
# the race. If the writer is killed by SIGPIPE mid-write, it never reaches
# its own `echo "$?" > marker` line, so the marker file is the proof: absent
# means the writer did not survive to report anything.
old_marker="$WORK_DIR/old_marker"
( sleep 0.5; printf '%s' "$PAYLOAD"; echo "wrote" > "$old_marker" ) | { : ; } 2>"$WORK_DIR/old_stderr"

if [ ! -s "$old_marker" ]; then
  echo "PASS: old pipe shape (writer | early-closing reader) kills the writer before it can complete -- the defect #1995 reports, reproduced deterministically"
else
  echo "FAIL: old pipe shape unexpectedly let the writer complete -- the defect this case exists to demonstrate did not reproduce"
  FAILURES=$((FAILURES + 1))
fi

# NEW shape: writer completes into a regular file first; the "reader" then
# reads the FINISHED file, with no concurrent writer left to break. Must
# always succeed, regardless of payload size or timing.
new_dump="$WORK_DIR/new_dump"
printf '%s' "$PAYLOAD" > "$new_dump"
new_write_rc=$?
: < "$new_dump"
new_read_rc=$?

if [ "$new_write_rc" -eq 0 ] && [ "$new_read_rc" -eq 0 ]; then
  echo "PASS: new shape (write to a file, then read the finished file) always succeeds -- no live pipe for a reader to close early"
else
  echo "FAIL: new shape unexpectedly failed (write rc=$new_write_rc, read rc=$new_read_rc)"
  FAILURES=$((FAILURES + 1))
fi

# ============================================================================
# Case 2: the real script, end to end, against a >4000-byte finding
# ============================================================================

STUB_DIR="$WORK_DIR/stub"
REPO_DIR="$WORK_DIR/repo"
OUT_FILE="$WORK_DIR/out"
mkdir -p "$STUB_DIR" "$REPO_DIR"

cat > "$STUB_DIR/uv" <<'STUB'
#!/usr/bin/env sh
if [ "$1" = "run" ] && [ "$2" = "pip-audit" ]; then
  cat "$PIPAUDIT_STUB_OUTPUT"
  exit 0
fi
echo "uv stub: unexpected invocation: $*" >&2
exit 99
STUB
chmod +x "$STUB_DIR/uv"

( cd "$REPO_DIR" \
  && git init -q -b trunk \
  && git config user.email test@example.com \
  && git config user.name "Test" )
cat > "$REPO_DIR/uv.lock" <<'LOCK'
version = 1
requires-python = ">=3.13"

[[package]]
name = "pip"
version = "26.1.2"
source = { registry = "https://pypi.org/simple" }
LOCK
( cd "$REPO_DIR" && git add -A && git commit -q -m base )
( cd "$REPO_DIR" && git branch -q "origin/dev" )

# A single package carrying enough vulns that jq's filtered dump of it
# exceeds 4000 bytes -- the exact condition #1995 requires (small payloads
# never hit the truncation path at all).
{
  printf '{"dependencies": [{"name": "pip", "version": "26.1.2", "vulns": ['
  i=0
  while [ "$i" -lt 60 ]; do
    [ "$i" -gt 0 ] && printf ','
    printf '{"id": "PYSEC-2026-%d", "fix_versions": ["26.2.1"], "description": "%s"}' \
      "$i" "$(head -c 200 /dev/zero | tr '\0' 'x')"
    i=$((i + 1))
  done
  printf ']}]}'
} > "$STUB_DIR/pip-audit-output.json"

filtered_size=$(cd "$REPO_DIR" && PATH="$STUB_DIR:$PATH" jq -c '[.dependencies[] | select(.vulns | length > 0)]' "$STUB_DIR/pip-audit-output.json" | wc -c | tr -d ' ')
if [ "$filtered_size" -le 4000 ]; then
  echo "FAIL: test fixture's filtered JSON is only ${filtered_size} bytes -- must exceed 4000 to exercise the truncation path #1995 is about"
  FAILURES=$((FAILURES + 1))
fi

(
  cd "$REPO_DIR" || exit 97
  PATH="$STUB_DIR:$PATH"
  export PATH
  PIPAUDIT_STUB_OUTPUT="$STUB_DIR/pip-audit-output.json"
  export PIPAUDIT_STUB_OUTPUT
  GITHUB_BASE_REF="dev"
  export GITHUB_BASE_REF
  sh "$TARGET"
) >"$OUT_FILE" 2>&1
rc=$?

# pip@26.1.2 is unchanged between base and PR-head (#1673 classification),
# so this must NOT block, same as case 1 in
# py-dependency-audit-classification.test.sh.
if [ "$rc" -eq 0 ]; then
  echo "PASS: real script exits 0 on a >4000-byte pre-existing finding"
else
  echo "FAIL: real script exited ${rc}, expected 0 -- output:"
  cat "$OUT_FILE"
  FAILURES=$((FAILURES + 1))
fi

if grep -qF "pre-existing" "$OUT_FILE"; then
  echo "PASS: real script still classifies the finding as pre-existing"
else
  echo "FAIL: real script's output does not mention 'pre-existing' -- output:"
  cat "$OUT_FILE"
  FAILURES=$((FAILURES + 1))
fi

out_size=$(wc -c < "$OUT_FILE" | tr -d ' ')
# The whole run's combined output, not just the dump, so this is a loose
# ceiling -- it exists to catch a regression that stops truncating at all
# (e.g. the dump ever growing back to the full ~13KB filtered JSON).
if [ "$out_size" -lt 8000 ]; then
  echo "PASS: real script's combined output (${out_size} bytes) stays bounded -- the dump is still truncated"
else
  echo "FAIL: real script's combined output is ${out_size} bytes -- the truncation may no longer be applied"
  FAILURES=$((FAILURES + 1))
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "py-dependency-audit-truncation.test.sh: all checks passed."
  exit 0
else
  echo "py-dependency-audit-truncation.test.sh: $FAILURES check(s) failed."
  exit 1
fi
