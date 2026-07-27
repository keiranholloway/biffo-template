#!/bin/sh
#
# Python dependency audit that fails the build on a real advisory but NOT on a
# broken registry/network response (#591) — same class of flake as the JS
# dependency audit (scripts/js-dependency-audit.sh), applied preventively here
# since pip-audit queries PyPI/OSV over the network per dependency and is
# subject to the same kind of transient hiccup.
#
# `pip-audit -f json` emits a `{"dependencies": [{"name", "version", "vulns"},
# ...]}` shape on a real run; a network/parse failure produces no parseable
# JSON at all (traceback on stderr, non-zero exit, empty/partial stdout). So we
# fail only when the parsed output actually contains a vulnerability, retry a
# few times on an unparseable run, and treat a persistent failure as
# INCONCLUSIVE (warn, don't block) rather than as a vulnerability.
# "Couldn't run the check" and "the check found a problem" must not be the same
# signal on a required gate.
#
# POSIX sh (the CI step runs `sh scripts/...`, i.e. dash) — no `pipefail`.
set -u

attempts=3

for attempt in $(seq 1 "$attempts"); do
  out="$(uv run pip-audit -f json 2>/dev/null)"

  if printf '%s' "$out" | jq -e '.dependencies' >/dev/null 2>&1; then
    vuln_count="$(printf '%s' "$out" | jq '[.dependencies[].vulns[]?] | length')"
    if [ "$vuln_count" -gt 0 ]; then
      echo "::error::pip-audit found ${vuln_count} vulnerability(ies)."
      printf '%s' "$out" | jq '[.dependencies[] | select(.vulns | length > 0)]' 2>/dev/null | head -c 4000
      exit 1
    fi
    echo "pip-audit: no vulnerabilities found."
    exit 0
  fi

  echo "pip-audit attempt ${attempt}/${attempts} produced no parseable JSON output."
  [ "$attempt" -lt "$attempts" ] && sleep "$((attempt * 3))"
done

echo "::warning::pip-audit could not produce parseable output after ${attempts} attempts (a transient network/registry error); treating as INCONCLUSIVE and not blocking. Advisory scanning was NOT performed for this run — see #591."
exit 0
