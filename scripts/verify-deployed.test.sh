#!/usr/bin/env sh
#
# Proves `verify-deployed.sh` catches the shapes it exists for, fails closed when it
# cannot tell, and — the assertion that matters most — never prints the credential it
# handles.
#
# Stubs `aws`, `curl` and `gh` through the script's own override variables, so this
# needs no network, no AWS account and no live deployment.
#
# Run: sh scripts/verify-deployed.test.sh

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TARGET="$SCRIPT_DIR/verify-deployed.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FAILURES=0
CHECKED=0
ok()  { CHECKED=$((CHECKED + 1)); echo "  ok   $1"; }
bad() { CHECKED=$((CHECKED + 1)); FAILURES=$((FAILURES + 1)); echo "  FAIL $1"; echo "       $2"; }

# The password the stubbed SSM hands back. Deliberately distinctive so the
# never-printed assertion cannot pass by accident on a short or common string.
SECRET='Zx9-QQQ-never-print-me-7413'

_mkstubs() {
  # _mkstubs <body-json> <status> [deployed-sha]
  body=$1; status=$2; sha=${3:-abc123}
  cat > "$TMP/aws" <<AWSEOF
#!/bin/sh
case "\$*" in
  *"apigatewayv2 get-apis"*) echo "https://stub.execute-api.eu-west-1.amazonaws.com" ;;
  *"ssm get-parameter"*)     echo '$SECRET' ;;
  *"initiate-auth"*)         echo '{"AuthenticationResult":{"IdToken":"stub.jwt.token"}}' ;;
esac
exit 0
AWSEOF
  cat > "$TMP/curl" <<CURLEOF
#!/bin/sh
case "\$*" in
  *"-w"*) printf '%s' '$status' ;;
  *)      printf '%s' '$body' ;;
esac
exit 0
CURLEOF
  cat > "$TMP/gh" <<GHEOF
#!/bin/sh
echo '$sha'
exit 0
GHEOF
  chmod +x "$TMP/aws" "$TMP/curl" "$TMP/gh"
}

_checks() {
  printf '%s\n' "$1" > "$TMP/checks"
}

_run() {
  # _run -> prints combined output; sets RC
  VERIFY_AWS="$TMP/aws" VERIFY_CURL="$TMP/curl" VERIFY_GH="$TMP/gh" \
  VERIFY_CHECKS="$TMP/checks" VERIFY_CLIENT_ID=stub-client \
  VERIFY_ORIGIN="https://stub.example" \
  ${VERIFY_EXTRA_ENV:-} sh "$TARGET" "$@" 2>&1
}

echo "verify-deployed.sh"

# --- the REVERT signal, which is the whole reason the `non-empty` shape exists -----
#
# A route that degrades silently returns `200 []` rather than 500ing, so status alone
# reports success on exactly the failure the check is for. If this assertion ever
# passes, the check is worthless.
_mkstubs '[]' '200'
_checks 'enrol unit-staff GET /api/v1/lms/my/enrollments non-empty'
out=$(_run enrol); rc=$?
[ "$rc" = "1" ] \
  && ok "a 200 with an empty array FAILS, and is called a revert signal" \
  || bad "a 200 with an empty array FAILS, and is called a revert signal" "rc=$rc out=$out"
case "$out" in *"REVERT signal"*) ok "the empty-body failure names it as a revert signal" ;;
  *) bad "the empty-body failure names it as a revert signal" "wording lost: $out" ;; esac

# ...and the other direction, or a check that always fails is equally useless.
_mkstubs '[{"id":"a"},{"id":"b"}]' '200'
out=$(_run enrol); rc=$?
[ "$rc" = "0" ] \
  && ok "a 200 with real items PASSES" \
  || bad "a 200 with real items PASSES" "rc=$rc out=$out"

# --- THE CREDENTIAL MUST NEVER APPEAR IN OUTPUT -----------------------------------
#
# biffo-fleet#264: two persona passwords leaked in one afternoon while agents
# established this capability by hand — once through argv, once through stdout. This
# script exists largely to close that class, so this is its load-bearing assertion.
# Checked on BOTH paths, because the failure path prints more.
_mkstubs '[{"id":"a"}]' '200'
out=$(_run enrol)
case "$out" in *"$SECRET"*) bad "the password never appears in output (pass path)" "LEAKED" ;;
  *) ok "the password never appears in output (pass path)" ;; esac
_mkstubs '[]' '200'
out=$(_run enrol)
case "$out" in *"$SECRET"*) bad "the password never appears in output (fail path)" "LEAKED" ;;
  *) ok "the password never appears in output (fail path)" ;; esac

# --- fails closed, every way it cannot tell ---------------------------------------
_mkstubs '[{"id":"a"}]' '200'
out=$(_run no-such-check); rc=$?
[ "$rc" = "2" ] && ok "an unknown check exits 2, not 0" || bad "an unknown check exits 2, not 0" "rc=$rc"

_checks 'broken unit-staff GET'
out=$(_run broken); rc=$?
[ "$rc" = "2" ] && ok "a malformed check line exits 2" || bad "a malformed check line exits 2" "rc=$rc out=$out"

_checks 'enrol unit-staff GET /x non-empty'
cat > "$TMP/aws" <<'AWSEOF'
#!/bin/sh
case "$*" in *"ssm get-parameter"*) echo "None" ;; *) echo "stub" ;; esac
exit 0
AWSEOF
chmod +x "$TMP/aws"
out=$(_run enrol); rc=$?
[ "$rc" = "2" ] && ok "a missing persona password exits 2, never 0" || bad "a missing persona password exits 2, never 0" "rc=$rc out=$out"

_mkstubs '[{"id":"a"}]' '200'
cat > "$TMP/aws" <<AWSEOF
#!/bin/sh
case "\$*" in
  *"apigatewayv2 get-apis"*) echo "https://stub.example" ;;
  *"ssm get-parameter"*)     echo '$SECRET' ;;
  *"initiate-auth"*)         echo '{"AuthenticationResult":{}}' ;;
esac
exit 0
AWSEOF
chmod +x "$TMP/aws"
out=$(_run enrol); rc=$?
[ "$rc" = "2" ] && ok "no IdToken in the auth result exits 2" || bad "no IdToken in the auth result exits 2" "rc=$rc out=$out"

# --- the stale-deploy guard -------------------------------------------------------
#
# A NON-EMPTY ANSWER FROM A BUILD THAT PREDATES THE CHANGE IS A FALSE PASS, and it is
# the most likely way this script reports success about nothing.
_mkstubs '[{"id":"a"}]' '200' 'deadbeef'
_checks 'enrol unit-staff GET /x non-empty'
out=$(VERIFY_EXPECT_SHA=ec1aa5dd _run enrol); rc=$?
[ "$rc" = "2" ] \
  && ok "a deploy that does not carry the expected sha exits 2, not 0" \
  || bad "a deploy that does not carry the expected sha exits 2, not 0" "rc=$rc out=$out"

_mkstubs '[{"id":"a"}]' '200' 'ec1aa5dd0000'
out=$(VERIFY_EXPECT_SHA=ec1aa5dd _run enrol); rc=$?
[ "$rc" = "0" ] \
  && ok "a deploy carrying the expected sha proceeds" \
  || bad "a deploy carrying the expected sha proceeds" "rc=$rc out=$out"

# --- status expectations ----------------------------------------------------------
_mkstubs 'anything' '403'
_checks 'denied brand-hq GET /api/v1/admin status:403'
out=$(_run denied); rc=$?
[ "$rc" = "0" ] && ok "a status: expectation passes when it matches" || bad "a status: expectation passes when it matches" "rc=$rc out=$out"
_mkstubs 'anything' '200'
out=$(_run denied); rc=$?
[ "$rc" = "1" ] && ok "a status: expectation fails when it does not match" || bad "a status: expectation fails when it does not match" "rc=$rc out=$out"

# --- the denominator --------------------------------------------------------------
#
# #1363: a report that does not print what it examined cannot be told from one that
# examined nothing.
_checks 'a x GET /y non-empty
b x GET /z non-empty'
out=$(_run --list)
case "$out" in *"2 check(s)"*) ok "--list prints its denominator" ;;
  *) bad "--list prints its denominator" "$out" ;; esac

echo
echo "  examined $CHECKED assertion(s): $((CHECKED - FAILURES)) passed, $FAILURES failed"
[ "$FAILURES" = "0" ] || exit 1
