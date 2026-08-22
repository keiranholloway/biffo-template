#!/usr/bin/env sh
#
# Verify a DEPLOYED behaviour as a real authenticated user, from a local script.
#
# ## Why this exists (biffo-fleet#167)
#
# A pile of post-merge obligations in this estate name a deployed observation as the
# thing that settles them — several of them REVERT signals on already-applied
# authorization changes. None had ever been collected, and the recorded reason was
# that agents cannot reach deployed infrastructure.
#
# That reason was wrong, and the way it was wrong matters. A `biffo-probe` genuinely
# cannot: its per-agent allowlist refuses `curl`, `psql` and `cognito-idp
# initiate-auth`. That limit was then generalised to the whole fleet, and a plan was
# nearly built to put a privileged verification endpoint on the public internet to
# work around it. Measured 2026-08-22: a `fleet-prosecutor` runs all four required
# steps — local script, SSM read, `initiate-auth`, authenticated HTTPS — with no
# refusal at all. The environment had the access the whole time; one agent type did
# not.
#
# So this is a local script. No new infrastructure, nothing to manage, nothing
# internet-reachable, and it is reviewable in a diff.
#
# ## The other reason it is a script and not an agent doing this by hand
#
# TWO persona passwords leaked in one afternoon while agents established this
# capability by hand (biffo-fleet#264). Neither was carelessness:
#
#   1. the secret was an ARGUMENT to a command the agent was asked to quote verbatim;
#   2. the secret was the entire RETURN VALUE of an inspection command, printed while
#      working out what shape the value was.
#
# A prompt cannot enumerate every route by which a secret escapes. This script closes
# the class instead: the password is read into a variable and never printed, the value
# shape is documented here so nobody needs to inspect it again, and the caller's whole
# command line becomes `sh scripts/verify-deployed.sh <check>` — which contains nothing
# to leak however verbatim it is quoted.
#
# ## Exit codes
#
# 0 = the check ran and the deployed behaviour is correct.
# 1 = the check ran and the behaviour is WRONG. For a REVERT-signal check this means
#     revert, not "open a follow-up".
# 2 = could not tell. Unreachable, no credential, no such check, deploy could not be
#     confirmed. 2 is NEVER a pass and callers must treat it exactly like 1.
#
# ## Usage
#
#   sh scripts/verify-deployed.sh <check-name>
#   sh scripts/verify-deployed.sh --list
#
# Checks live in `scripts/verify-deployed.checks` beside this file, which each instance
# owns — the mechanism is the same estate-wide, the checks are not. Format and an
# example are in that file.
#
# VERIFY_AWS   — override the aws binary (tests point this at a stub).
# VERIFY_CURL  — override the curl binary (tests point this at a stub).
# VERIFY_GH    — override the gh binary (tests point this at a stub).
# VERIFY_CHECKS — override the checks file path.
#
# Run this file's own tests: sh scripts/verify-deployed.test.sh

set -u

AWS=${VERIFY_AWS:-aws}
CURL=${VERIFY_CURL:-curl}
GH=${VERIFY_GH:-gh}
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CHECKS=${VERIFY_CHECKS:-$SCRIPT_DIR/verify-deployed.checks}

_die() { echo "verify-deployed: $1" >&2; exit "${2:-2}"; }

# --- the check registry -------------------------------------------------------
#
# One check per line, whitespace-separated:
#
#   <name> <persona-id> <method> <path> <expect>
#
# `expect` is one of `non-empty` or `status:<code>`. Deliberately a tiny vocabulary:
# a check that needs to assert something richer is a check that wants a real test, in
# the repo that owns the behaviour, not a line in a shell data file.
_checks_or_die() {
  [ -f "$CHECKS" ] || _die "no checks file at $CHECKS — nothing to verify"
  grep -vE '^[[:space:]]*(#|$)' "$CHECKS"
}

if [ "${1:-}" = "--list" ]; then
  n=0
  _checks_or_die | while read -r name _rest; do echo "  $name"; done
  n=$(_checks_or_die | grep -c .)
  echo "$n check(s) defined in $CHECKS"
  exit 0
fi

CHECK=${1:-}
[ -n "$CHECK" ] || _die "usage: sh scripts/verify-deployed.sh <check-name> | --list"

LINE=$(_checks_or_die | awk -v want="$CHECK" '$1 == want { print; exit }')
[ -n "$LINE" ] || _die "no check named '$CHECK' in $CHECKS — run --list"

# shellcheck disable=SC2086
set -- $LINE
PERSONA=${2:-}
METHOD=${3:-}
PATH_=${4:-}
EXPECT=${5:-}
[ -n "$PERSONA" ] && [ -n "$METHOD" ] && [ -n "$PATH_" ] && [ -n "$EXPECT" ] ||
  _die "check '$CHECK' is malformed: expected '<name> <persona> <method> <path> <expect>'"

# --- 1. resolve the deployment, never hardcode it -----------------------------
#
# THE ORIGIN IS THE execute-api HOST, NOT THE FRIENDLY DOMAIN. Measured 2026-08-22:
# `dev.<domain>/openapi.json` returns 403 from CloudFront without ever reaching the
# API, while the same path on the execute-api origin returns 401 from API Gateway.
# A check pointed at the friendly domain reports on the CDN, not on the application,
# and the two failures are indistinguishable by status code alone.
#
# All APIs in this estate are HTTP APIs (v2). `aws apigateway ...` is REST (v1) and
# returns an empty list here, which reads as "no API" and is how one measurement
# already went wrong.
ORIGIN=${VERIFY_ORIGIN:-}
if [ -z "$ORIGIN" ]; then
  ORIGIN=$($AWS apigatewayv2 get-apis --query "Items[?Name=='${VERIFY_API_NAME:-}'].ApiEndpoint | [0]" --output text 2>/dev/null)
  [ "$ORIGIN" = "None" ] && ORIGIN=""
fi
[ -n "$ORIGIN" ] || _die "could not resolve the API origin — set VERIFY_ORIGIN or VERIFY_API_NAME"

# --- 2. confirm what is actually deployed -------------------------------------
#
# A NON-EMPTY ANSWER FROM A STALE LAMBDA IS A FALSE PASS, and it is the failure this
# check is most likely to produce. If the deployed build predates the change under
# test, the behaviour observed says nothing about it — it may be passing for the
# reason the change was meant to fix. So the deploy is asserted, not assumed.
#
# Skipped only when the caller explicitly says which commit it expects to be live and
# supplies nothing to check it against; never skipped silently.
if [ -n "${VERIFY_EXPECT_SHA:-}" ]; then
  deployed=$($GH run list --workflow "Deploy Application" --branch dev --limit 20 \
               --json headSha,conclusion \
               --jq "[.[] | select(.conclusion==\"success\")] | .[0].headSha" 2>/dev/null)
  case "$deployed" in
    "$VERIFY_EXPECT_SHA"*) : ;;
    "") _die "could not read deploy history — cannot tell what is live" ;;
    *)  _die "the newest successful deploy is $deployed, not $VERIFY_EXPECT_SHA — the behaviour under test may not be deployed" ;;
  esac
fi

# --- 3. mint a token, without the password ever reaching a log ----------------
#
# THE SSM VALUE IS THE BARE PASSWORD. No JSON wrapper, no key. Documented here
# because establishing that fact by inspection is exactly how the second leak in
# biffo-fleet#264 happened — an agent printed the value to see its shape.
#
# The username convention is `keiran+<persona-id-without-dashes>@<domain>`, defined in
# the API's own persona table. It is NOT in SSM, so it is derived here and will drift
# silently if that table is ever renamed — an accepted, stated risk rather than a
# hidden one.
PERSONA_PATH=${VERIFY_PERSONA_PREFIX:-/tabsii/dev/simulation/personas}/$PERSONA
PW=$($AWS ssm get-parameter --name "$PERSONA_PATH" --with-decryption \
       --query 'Parameter.Value' --output text 2>/dev/null)
[ -n "$PW" ] && [ "$PW" != "None" ] || _die "no persona password at $PERSONA_PATH"

USERNAME=${VERIFY_USERNAME:-keiran+$(printf '%s' "$PERSONA" | tr -d '-')@${VERIFY_EMAIL_DOMAIN:-tabsii.com}}
CLIENT_ID=${VERIFY_CLIENT_ID:-}
[ -n "$CLIENT_ID" ] || _die "VERIFY_CLIENT_ID is not set — cannot mint a token"

AUTH=$($AWS cognito-idp initiate-auth \
         --client-id "$CLIENT_ID" \
         --auth-flow USER_PASSWORD_AUTH \
         --auth-parameters "USERNAME=$USERNAME,PASSWORD=$PW" 2>/dev/null)
PW=""
[ -n "$AUTH" ] || _die "initiate-auth returned nothing for $USERNAME"

TOKEN=$(printf '%s' "$AUTH" | sed -n 's/.*"IdToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
AUTH=""
[ -n "$TOKEN" ] || _die "no IdToken in the auth result for $USERNAME"

# --- 4. call it, and judge -----------------------------------------------------
BODY=$($CURL -s -X "$METHOD" -H "Authorization: Bearer $TOKEN" "$ORIGIN$PATH_" 2>/dev/null)
STATUS=$($CURL -s -o /dev/null -w '%{http_code}' -X "$METHOD" -H "Authorization: Bearer $TOKEN" "$ORIGIN$PATH_" 2>/dev/null)
TOKEN=""

echo "verify-deployed: $CHECK — $METHOD $PATH_ as $PERSONA → HTTP ${STATUS:-?}"

case "$EXPECT" in
  status:*)
    want=${EXPECT#status:}
    if [ "$STATUS" = "$want" ]; then echo "  [OK]   status $STATUS as expected"; exit 0
    else echo "  [FAIL] expected status $want, got ${STATUS:-none}"; exit 1; fi
    ;;
  non-empty)
    # A 200 WITH AN EMPTY ARRAY IS THE FAILURE, NOT AN ABSENCE OF ONE. This shape
    # exists because the route it was written for degrades silently: an unbound
    # tenant GUC yields `200 []` rather than a 500, so the check that matters is
    # emptiness, not status.
    [ "$STATUS" = "200" ] || { echo "  [FAIL] expected 200, got ${STATUS:-none}"; exit 1; }
    case "$(printf '%s' "$BODY" | tr -d ' \n')" in
      ''|'[]'|'{}'|'{"items":[]}')
        echo "  [FAIL] 200 with an EMPTY body — this is a REVERT signal, not a follow-up"
        exit 1 ;;
      *)
        items=$(printf '%s' "$BODY" | grep -o '"id"' | grep -c . 2>/dev/null || echo "?")
        echo "  [OK]   200 with a non-empty body (~$items item(s))"
        exit 0 ;;
    esac
    ;;
  *) _die "check '$CHECK' has an unknown expectation '$EXPECT'" ;;
esac
