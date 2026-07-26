#!/usr/bin/env bash
#
# JS dependency audit that fails the build on a real high/critical advisory but
# NOT on a broken audit registry (#591).
#
# `pnpm audit --audit-level=high` exits non-zero identically whether it found a
# vulnerability OR simply couldn't parse the registry's response — and the npm
# audit endpoint intermittently returns a non-JSON/gzip body pnpm chokes on
# ("Unexpected token, is not valid JSON"), which then fails the required JS check
# on every open PR at once, blocking the whole merge queue for an infrastructure
# hiccup that has nothing to do with the PR.
#
# `pnpm audit --json` disambiguates: a real run yields `.metadata.vulnerabilities`
# (counts by severity); a registry/parse failure yields `.error`. So we fail only
# on a genuine high+critical finding, retry a transient registry error a few
# times, and treat a persistent one as INCONCLUSIVE (warn, don't block) rather
# than as a vulnerability. "Couldn't run the check" and "the check found a
# problem" must not be the same signal on a required gate.
#
set -uo pipefail

attempts=3

for attempt in $(seq 1 "$attempts"); do
  out="$(pnpm audit --json 2>/dev/null)"

  if echo "$out" | jq -e '.metadata.vulnerabilities' >/dev/null 2>&1; then
    high="$(echo "$out" | jq '.metadata.vulnerabilities.high // 0')"
    crit="$(echo "$out" | jq '.metadata.vulnerabilities.critical // 0')"
    if [ "$((high + crit))" -gt 0 ]; then
      echo "::error::pnpm audit found ${crit} critical + ${high} high advisory(ies)."
      echo "$out" | jq '.advisories // .metadata.vulnerabilities' 2>/dev/null | head -c 4000
      exit 1
    fi
    echo "pnpm audit: no high/critical advisories."
    exit 0
  fi

  msg="$(echo "$out" | jq -r '.error.message // "no parseable audit output"' 2>/dev/null | head -c 200)"
  echo "pnpm audit attempt ${attempt}/${attempts} could not run: ${msg}"
  [ "$attempt" -lt "$attempts" ] && sleep "$((attempt * 3))"
done

echo "::warning::pnpm audit could not run after ${attempts} attempts (the audit registry returned a non-JSON/error response); treating as INCONCLUSIVE and not blocking. Advisory scanning was NOT performed for this run — see #591."
exit 0
