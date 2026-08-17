#!/usr/bin/env sh
#
# Core-revision preflight (#1604).
#
# ## Why this exists
#
# A sibling's deploy is structurally incapable of seeing core's deploy state:
# `resolve-environment -> deploy-infra -> deploy-app` runs with no step that
# reads anything about core, and its only post-deploy proof is its OWN Lambda
# health and its OWN CDN route. Merge ordering does not fix this either — in
# the recorded incident the core PR had already merged and the core deploy
# simply sat in the runner queue while the sibling went live first, serving
# requests against routes core had not shipped yet.
#
# The owner's decision (#1604): core publishes a DIGEST of its route table to
# the existing public `.well-known/` channel — a monotonic revision counter
# paired with a content hash, never the route surface itself (`/openapi.json`
# stays 401-gated). This script is the consumer half: it asks "is core at
# least at the revision I need", using ONLY that published digest, run
# BEFORE `deploy-app` so a sibling that would go live ahead of core never
# gets that far.
#
# ## Why "revision", not the hash
#
# The hash proves the route table is DIFFERENT from some prior observation;
# it cannot prove "at or past", because "different" has no direction. The
# published `revision` is core's `git rev-list --count HEAD` at deploy time
# (scripts/route-table-digest.py) — the number of commits reachable from the
# deployed commit, not a counter that increments once per deploy. That
# distinction is the whole point: a deploy counter goes up on every run
# regardless of what shipped, so a ROLLBACK (a new deploy of an OLDER
# commit) would report a revision higher than the one that actually had the
# routes a sibling needs — a false "yes, at or past" fired exactly when the
# true answer is "no". A commit count is tied to the code's real position in
# history: redeploying the same commit reports the same revision (correctly
# "at least as new" — an equality, not a regression); rolling back to an
# older commit reports a LOWER revision, because that commit genuinely has
# fewer ancestors. This script only ever compares that one integer.
#
# ## Fail-closed (the #1363 class)
#
# A sibling that declares no minimum has nothing to check — that is a
# legitimate "I depend on nothing new from core" state, and it passes with a
# notice. But once a minimum IS declared, absence of the digest — an older
# core, a failed publish, a CDN cache miss — must never read as "satisfied".
# It fails, and says WHICH: "missing/unreachable" and "present but behind"
# are different facts, and a caller reading only the exit code must not be
# able to mistake one for the other from the log.
#
# Exit codes:
#   0 = no minimum declared (nothing to check), or core is at/past it.
#   1 = core is behind the declared minimum, the digest is missing or
#       unreachable, or the digest could not be parsed. Every one of these
#       is "not verified as safe" and none may be treated as a pass.
#
# ## Usage
#
#   CORE_MIN_ROUTE_REVISION=42 \
#   CORE_ROUTE_REVISION_URL=https://dev.example.com/.well-known/route-revision.json \
#     sh scripts/core-revision-preflight.sh
#
# CORE_MIN_ROUTE_REVISION — the minimum core revision this sibling's code
#                            needs. Set as a per-environment repo variable
#                            (vars.CORE_MIN_ROUTE_REVISION), the same way a
#                            version pin is set by hand: after merging the
#                            core PR your sibling code depends on, read the
#                            `revision` core published for that deploy and
#                            record it here. Unset/empty means "no new
#                            dependency" and the check is skipped.
# CORE_ROUTE_REVISION_URL  — where to fetch the digest, typically
#                            "${CORE_PORTAL_URL}/.well-known/route-revision.json".
#                            Required whenever a minimum is declared.
# PREFLIGHT_CURL           — override the curl binary/wrapper (tests use
#                            this to point at a stub).
#
# Run this file's own tests: sh scripts/core-revision-preflight.test.sh

set -u

CURL=${PREFLIGHT_CURL:-curl}

MIN=${CORE_MIN_ROUTE_REVISION:-}
if [ -z "$MIN" ]; then
  echo "core-revision-preflight: CORE_MIN_ROUTE_REVISION not set — this sibling declares no core-route dependency, nothing to check."
  exit 0
fi

case "$MIN" in
  ''|*[!0-9]*)
    echo "::error::core-revision-preflight: CORE_MIN_ROUTE_REVISION='$MIN' is not a non-negative integer." >&2
    exit 1
    ;;
esac

URL=${CORE_ROUTE_REVISION_URL:-}
if [ -z "$URL" ]; then
  echo "::error::core-revision-preflight: CORE_MIN_ROUTE_REVISION=$MIN is declared but CORE_ROUTE_REVISION_URL is not set — cannot fetch the digest to check it against. Refusing to proceed rather than assuming core is ready." >&2
  exit 1
fi

BODY_FILE=/tmp/core-revision-preflight-body.$$
ERR_FILE=/tmp/core-revision-preflight-err.$$
trap 'rm -f "$BODY_FILE" "$ERR_FILE"' EXIT

HTTP_CODE=$("$CURL" -sS --max-time 15 --retry 2 --retry-delay 2 \
  -o "$BODY_FILE" -w '%{http_code}' "$URL" 2>"$ERR_FILE")
RC=$?
ERR=$(cat "$ERR_FILE" 2>/dev/null)

if [ "$RC" -ne 0 ] || [ "$HTTP_CODE" != "200" ]; then
  echo "::error::core-revision-preflight: no route-revision digest available at $URL (curl exit $RC, http ${HTTP_CODE:-none}${ERR:+, $ERR}). An absent or unreachable digest is treated as NOT satisfied — this is expected on an older core, a failed publish, or a CDN cache miss, and is a DIFFERENT fact from 'core is behind revision $MIN'. Refusing to deploy rather than assuming core is ready." >&2
  exit 1
fi

ACTUAL=$(command -v jq >/dev/null 2>&1 && jq -r 'if (.revision | type) == "number" then (.revision | floor) else empty end' "$BODY_FILE" 2>/dev/null)

case "${ACTUAL:-}" in
  ''|*[!0-9]*)
    echo "::error::core-revision-preflight: digest at $URL did not contain a valid integer 'revision' field. Treating a malformed digest the same as a missing one — refusing to deploy." >&2
    exit 1
    ;;
esac

if [ "$ACTUAL" -ge "$MIN" ]; then
  echo "core-revision-preflight: OK — core is at revision $ACTUAL, this sibling needs at least $MIN."
  exit 0
fi

echo "::error::core-revision-preflight: core is at revision $ACTUAL, but this sibling needs at least $MIN. Core has not deployed the routes this sibling depends on yet — refusing to deploy ahead of it." >&2
exit 1
