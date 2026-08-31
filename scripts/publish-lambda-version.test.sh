#!/usr/bin/env sh
#
# Proves publish-lambda-version.sh (#1747) actually publishes a version and
# moves the `live` alias to it, fails closed rather than moving the alias to
# nothing when publish-version returns no version, and fails closed when the
# AWS call itself fails — never silently leaving the alias where it was
# while reporting success.
#
# Stubs `aws` on PATH so this needs no network and no live deployment.
#
# Run: sh scripts/publish-lambda-version.test.sh

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TARGET="$SCRIPT_DIR/publish-lambda-version.sh"
STUB_DIR=$(mktemp -d)
OUT_FILE=/tmp/publish-lambda-version-test-out.$$
CALL_LOG="$STUB_DIR/calls.log"
trap 'rm -rf "$STUB_DIR"; rm -f "$OUT_FILE"' EXIT

FAILURES=0

# _run <function-name-or-empty> -- runs the target with
# PUBLISH_LAMBDA_VERSION_AWS pointed at the stub, capturing combined output
# to $OUT_FILE and the exit code into $LAST_RC. Not run inside a
# subshell/command-substitution — see core-revision-preflight.test.sh for why
# that matters for FAILURES bookkeeping.
_run() {
  : > "$CALL_LOG"
  if [ -n "${1:-}" ]; then
    PUBLISH_LAMBDA_VERSION_AWS="$STUB_DIR/aws" sh "$TARGET" "$1" >"$OUT_FILE" 2>&1
  else
    PUBLISH_LAMBDA_VERSION_AWS="$STUB_DIR/aws" sh "$TARGET" >"$OUT_FILE" 2>&1
  fi
  LAST_RC=$?
}

_assert_exit() {
  name=$1
  expected=$2
  if [ "$LAST_RC" -eq "$expected" ]; then
    echo "PASS: $name (exit $LAST_RC)"
  else
    echo "FAIL: $name — expected exit $expected, got $LAST_RC"
    echo "--- output ---"; cat "$OUT_FILE"; echo "--------------"
    FAILURES=$((FAILURES + 1))
  fi
}

_assert_output_contains() {
  name=$1
  needle=$2
  if grep -qF "$needle" "$OUT_FILE"; then
    echo "PASS: $name mentions '$needle'"
  else
    echo "FAIL: $name — expected output to mention '$needle'"
    echo "--- output ---"; cat "$OUT_FILE"; echo "--------------"
    FAILURES=$((FAILURES + 1))
  fi
}

_assert_alias_moved_to() {
  # _assert_alias_moved_to <scenario-name> <expected-version>
  name=$1
  expected=$2
  if grep -qF "update-alias --function-version $expected" "$CALL_LOG"; then
    echo "PASS: $name — update-alias called with version $expected"
  else
    echo "FAIL: $name — expected update-alias called with version $expected"
    echo "--- call log ---"; cat "$CALL_LOG"; echo "----------------"
    FAILURES=$((FAILURES + 1))
  fi
}

_assert_alias_never_moved() {
  name=$1
  if grep -q "update-alias" "$CALL_LOG"; then
    echo "FAIL: $name — update-alias must not be called"
    echo "--- call log ---"; cat "$CALL_LOG"; echo "----------------"
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS: $name — update-alias never called"
  fi
}

# --- Stub aws factory ----------------------------------------------------
# Dispatches on the `lambda <subcommand>` pair. Logs a normalised summary of
# every invocation (subcommand + the flags this script actually passes) so
# assertions can check both WHAT was called and with WHAT arguments, without
# depending on flag order.
_write_stub() {
  publish_version=$1     # value publish-version prints on --query Version, or "" for empty
  publish_exit=${2:-0}   # exit code for publish-version
  alias_exit=${3:-0}     # exit code for update-alias
  cat > "$STUB_DIR/aws" <<STUB
#!/usr/bin/env sh
sub=\$2
fn=""
version=""
prev=""
for a in "\$@"; do
  case "\$prev" in
    --function-name) fn="\$a" ;;
    --function-version) version="\$a" ;;
  esac
  prev="\$a"
done
case "\$sub" in
  publish-version)
    echo "publish-version --function-name \$fn" >> "$CALL_LOG"
    [ "$publish_exit" -eq 0 ] || exit "$publish_exit"
    printf '%s' "$publish_version"
    exit 0
    ;;
  update-alias)
    echo "update-alias --function-version \$version" >> "$CALL_LOG"
    [ "$alias_exit" -eq 0 ] || exit "$alias_exit"
    printf 'arn:aws:lambda:us-east-1:123456789012:function:\$fn:live'
    exit 0
    ;;
  *)
    echo "unexpected aws subcommand: \$*" >&2
    exit 99
    ;;
esac
STUB
  chmod +x "$STUB_DIR/aws"
}

# 1. No function name argument at all — must fail without invoking aws.
_write_stub "7"
_run ""
_assert_exit "no function name argument" 1
_assert_output_contains "no function name argument — names the usage" "usage: publish-lambda-version.sh"
_assert_alias_never_moved "no function name argument"

# 2. Happy path — publishes a version and moves the alias to exactly that
#    version, naming both the function and the version in its own output.
_write_stub "7"
_run "my-app-dev-core-api"
_assert_exit "happy path" 0
_assert_alias_moved_to "happy path" "7"
_assert_output_contains "happy path — names the function" "my-app-dev-core-api"
_assert_output_contains "happy path — names the version" "version 7"

# 2b. A different function/version pair — proves the version threaded through
#     is the one publish-version actually returned, not a hardcoded stub
#     artifact from test 2.
_write_stub "42"
_run "my-app-dev-plugin-host"
_assert_exit "second happy path" 0
_assert_alias_moved_to "second happy path" "42"

# 3. publish-version succeeds (exit 0) but returns no version number — must
#    fail closed and must NEVER call update-alias with an empty/garbage
#    version. A silent no-op here would leave `live` on the OLD code while
#    the deploy step ahead of it reports success.
_write_stub ""
_run "my-app-dev-core-api"
_assert_exit "publish-version returns no version" 1
_assert_output_contains "publish-version returns no version — names the cause" "returned no version number"
_assert_alias_never_moved "publish-version returns no version"

# 4. publish-version itself fails (AWS API error, e.g. throttling or the
#    function still mid-update despite the caller's wait) — must propagate
#    the failure, never treat it as "nothing to move".
_write_stub "7" 1
_run "my-app-dev-core-api"
_assert_exit "publish-version call fails" 1
_assert_alias_never_moved "publish-version call fails"

# 5. publish-version succeeds but update-alias fails — must propagate the
#    failure rather than reporting the version as published successfully.
_write_stub "7" 0 1
_run "my-app-dev-core-api"
_assert_exit "update-alias call fails" 1

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "publish-lambda-version.test.sh: all checks passed."
  exit 0
else
  echo "publish-lambda-version.test.sh: $FAILURES check(s) failed."
  exit 1
fi
