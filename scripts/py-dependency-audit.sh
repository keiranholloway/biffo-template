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
# ## Skeleton lockfiles are audited too (#719)
#
# `_skeletons/**/` are scaffolding trees: `biffo sibling create` / `plugin
# create` copy them verbatim into a brand-new repo. They are NOT part of this
# repo's uv project, so `uv sync` never installs them and a workspace-scoped
# `uv run pip-audit` never saw them — which meant the Python half of every
# scaffolded sibling came from a lockfile no CI gate had ever looked at.
#
# #644 closed exactly this hole for the JS skeleton lockfile, where it had
# already cost four unseen high-severity advisories; this is the same hole one
# language over. It is the fail-open shape this file already exists to fight,
# one level up: the gate was green because it was not looking, and "we checked
# and it is clean" read identically to "we never checked".
#
# Unlike `pnpm audit --ignore-workspace`, pip-audit cannot simply be run inside
# a skeleton directory: the skeleton is not an installed environment, and
# pip-audit's default mode audits an environment. So we export `--frozen`
# requirements from the skeleton's own lockfile (a read of the committed lock,
# no re-resolution) and audit those with `-r`, from the workspace, which is
# where pip-audit is actually installed.
#
# POSIX sh (the CI step runs `sh scripts/...`, i.e. dash) — no `pipefail`.
set -u

attempts=3
inconclusive=0
failed=0

# Audit one dependency set. Returns 0 if clean or inconclusive, 1 on a real
# finding. `$1` is a human label, `$2` the extra pip-audit flags that select
# what to audit — empty for this workspace's installed environment, or
# `-r <file>` for a requirements file exported from a skeleton lockfile.
audit_deps() {
  label="$1"
  extra="$2"

  for attempt in $(seq 1 "$attempts"); do
    # shellcheck disable=SC2086
    out="$(uv run pip-audit -f json $extra 2>/dev/null)"

    # printf, never echo: the CI step runs `sh scripts/...` i.e. dash, whose
    # `echo` interprets backslash escapes. Advisory payloads contain them, so
    # `echo "$out" | jq` mangles the JSON and jq rejects it — the run then reads
    # as "the registry returned junk" and reports INCONCLUSIVE. That is this
    # gate failing open inside the very fix that exists to stop it failing open
    # (#591): green, every time, while scanning nothing. #644 found the JS gate
    # had been doing exactly that on every run.
    if printf '%s' "$out" | jq -e '.dependencies' >/dev/null 2>&1; then
      vuln_count="$(printf '%s' "$out" | jq '[.dependencies[].vulns[]?] | length')"
      if [ "$vuln_count" -gt 0 ]; then
        echo "::error::${label}: ${vuln_count} vulnerability(ies)."
        printf '%s' "$out" | jq '[.dependencies[] | select(.vulns | length > 0)]' 2>/dev/null | head -c 4000
        return 1
      fi
      echo "${label}: no vulnerabilities found."
      return 0
    fi

    echo "${label}: attempt ${attempt}/${attempts} produced no parseable JSON output."
    [ "$attempt" -lt "$attempts" ] && sleep "$((attempt * 3))"
  done

  echo "::warning::${label}: could not produce parseable output after ${attempts} attempts (a transient network/registry error); treating as INCONCLUSIVE and not blocking. Advisory scanning was NOT performed for this tree — see #591."
  inconclusive=$((inconclusive + 1))
  return 0
}

# The workspace itself.
audit_deps "pip-audit (workspace)" "" || failed=1

# Every scaffolding tree with its own lockfile. Discovered rather than listed,
# so a new skeleton is covered the day it lands instead of the day someone
# remembers to add it here.
for lock in $(find _skeletons -name uv.lock -not -path '*/node_modules/*' 2>/dev/null | sort); do
  dir="$(dirname "$lock")"
  reqs="$(mktemp)"

  # `--frozen` reads the committed lock verbatim instead of re-resolving, so
  # what gets audited is exactly what a scaffolded sibling would be born with.
  # `--no-emit-project` drops the skeleton package itself (nothing published to
  # audit); `--no-dev` keeps the audit to what actually ships.
  if (cd "$dir" && uv export --frozen --no-dev --no-emit-project) >"$reqs" 2>/dev/null && [ -s "$reqs" ]; then
    audit_deps "pip-audit (${dir})" "-r $reqs" || failed=1
  else
    # An export failure is "couldn't run", not "clean" — same discipline as a
    # transient pip-audit error, and it must never read as a pass.
    echo "::warning::pip-audit (${dir}): could not export requirements from ${lock}; treating as INCONCLUSIVE and not blocking. Advisory scanning was NOT performed for this tree — see #719."
    inconclusive=$((inconclusive + 1))
  fi

  rm -f "$reqs"
done

if [ "$failed" -ne 0 ]; then
  exit 1
fi

if [ "$inconclusive" -ne 0 ]; then
  echo "${inconclusive} tree(s) could not be audited; see warnings above."
fi

exit 0
