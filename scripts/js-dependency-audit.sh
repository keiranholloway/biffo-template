#!/bin/sh
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
# ## Skeleton lockfiles are audited too (#644)
#
# `_skeletons/**/` are scaffolding trees: `biffo sibling create` / `plugin
# create` copy them verbatim into a brand-new repo. They sit OUTSIDE the pnpm
# workspace, so `pnpm install` never installs them and a workspace-scoped audit
# never sees them — which meant every sibling scaffolded from this template was
# born with four high-severity advisories nobody could see. Dependabot found
# them; the required JS gate could not, by construction.
#
# That is the fail-open shape this file already exists to fight, one level up:
# the gate was green because it was not looking, and "we checked and it is
# clean" read identically to "we never checked".
#
# POSIX sh (the CI step runs `sh scripts/...`, i.e. dash) — no `pipefail`.
set -u

attempts=3
inconclusive=0
failed=0

# Audit one directory. Returns 0 if clean or inconclusive, 1 on a real finding.
# `$1` is the directory, `$2` a human label, `$3` extra pnpm flags.
audit_dir() {
  dir="$1"
  label="$2"
  extra="$3"

  for attempt in $(seq 1 "$attempts"); do
    # printf, never echo: the CI step runs `sh scripts/...` i.e. dash, whose
    # `echo` interprets backslash escapes. Advisory payloads contain them, so
    # `echo "$out" | jq` mangles the JSON and jq rejects it — the run then reads
    # as "the registry returned junk" and reports INCONCLUSIVE. That is this
    # gate failing open inside the very fix that exists to stop it failing open
    # (#591): green, every time, while scanning nothing.
    #
    # The flag differs by tree, and both directions matter:
    #   - skeletons need --ignore-workspace, or pnpm walks up, finds this repo's
    #     workspace root and audits THAT instead — reporting a clean result for
    #     a tree it never looked at, which is the failure this step closes.
    #   - the workspace must NOT have it, or pnpm has no project to audit and
    #     every run reports INCONCLUSIVE. That fails open: the gate goes green
    #     forever while scanning nothing. (Caught by running this script before
    #     trusting it — the workspace audit had silently stopped working.)
    # shellcheck disable=SC2086
    out="$(cd "$dir" 2>/dev/null && pnpm audit --json $extra 2>/dev/null)"

    if printf '%s' "$out" | jq -e '.metadata.vulnerabilities' >/dev/null 2>&1; then
      high="$(printf '%s' "$out" | jq '.metadata.vulnerabilities.high // 0')"
      crit="$(printf '%s' "$out" | jq '.metadata.vulnerabilities.critical // 0')"
      if [ "$((high + crit))" -gt 0 ]; then
        echo "::error::${label}: ${crit} critical + ${high} high advisory(ies)."
        printf '%s' "$out" | jq '.advisories // .metadata.vulnerabilities' 2>/dev/null | head -c 4000
        return 1
      fi
      echo "${label}: no high/critical advisories."
      return 0
    fi

    msg="$(printf '%s' "$out" | jq -r '.error.message // "no parseable audit output"' 2>/dev/null | head -c 200)"
    echo "${label}: attempt ${attempt}/${attempts} could not run: ${msg}"
    [ "$attempt" -lt "$attempts" ] && sleep "$((attempt * 3))"
  done

  echo "::warning::${label}: audit could not run after ${attempts} attempts (the registry returned a non-JSON/error response); treating as INCONCLUSIVE and not blocking. Advisory scanning was NOT performed for this tree — see #591."
  inconclusive=$((inconclusive + 1))
  return 0
}

# The workspace itself.
audit_dir "." "pnpm audit (workspace)" "" || failed=1

# Every scaffolding tree with its own lockfile. Discovered rather than listed,
# so a new skeleton is covered the day it lands instead of the day someone
# remembers to add it here.
for lock in $(find _skeletons -name pnpm-lock.yaml -not -path '*/node_modules/*' 2>/dev/null | sort); do
  audit_dir "$(dirname "$lock")" "pnpm audit ($(dirname "$lock"))" "--ignore-workspace" || failed=1
done

if [ "$failed" -ne 0 ]; then
  exit 1
fi

if [ "$inconclusive" -ne 0 ]; then
  echo "${inconclusive} tree(s) could not be audited; see warnings above."
fi

exit 0
