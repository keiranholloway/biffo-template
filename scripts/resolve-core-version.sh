#!/usr/bin/env sh
#
# Emit the core version this checkout represents, or fail loudly (#648).
#
# ## Why this exists rather than reading `core.version`
#
# #648 asked for `/health` to report the deployed core version by bundling the
# repo-root `core.version` and walking up to find it at runtime. That file is a
# fossil since #423: on `biffo-platform` it reads `0.41.17` against an authority of
# `0.181.0`, so the endpoint whose only job is saying what is deployed would have
# been 140 releases wrong. #842 now deletes it outright, so the feature would then
# have found nothing. Both halves measured 2026-07-30.
#
# So the version comes from the two places that are actually authoritative:
#
#   - an INSTANCE carries `biffo.core.json` (ADR-0006). That is the authority.
#   - the TEMPLATE carries none — it is not an instance — so its own version is
#     the highest `core-v*` tag, which is exactly what `getLatestCoreVersion()`
#     falls back to on the CLI side.
#
# ## Failing loudly is the point
#
# This is resolved at BUILD time, not runtime, specifically so that "we could not
# tell" is a red build rather than a `/health` response quietly reading `unknown`
# months later. Every real checkout has one of the two sources; having neither
# means something is wrong with the checkout, and a deploy carrying an unknown
# version is worth stopping for.
#
# The trap that makes this non-obvious: `actions/checkout` defaults to
# `fetch-depth: 1`, which fetches NO tags. The template path therefore needs
# `fetch-tags: true` on the job's checkout, and without it this script fails —
# which is the intended behaviour, not a bug to work around.
#
# Usage:
#   sh scripts/resolve-core-version.sh          # from anywhere
#   sh scripts/resolve-core-version.sh --quiet  # no diagnostics on stderr
set -eu

# Find the checkout the CALLER is standing in, by walking up for the instance
# authority. `deploy-app.yml` runs this with `working-directory: api-service` —
# the directory `download-artifact` unpacks the built API into, one level below
# the checkout root — where a bare `[ -f biffo.core.json ]` sees nothing. The
# script then reported "cannot determine a core version" and failed every
# deploy, which reads as a missing version rather than a wrong directory. The
# version was present the whole time, one level up.
#
# ## Why up from the caller, and NOT from this script's own location
#
# Resolving `dirname $0/..` looks equivalent and is not: it would make the
# script always answer about the repo it *lives in*, ignoring the caller
# entirely. That breaks the two properties this file exists to guarantee, both
# already asserted in services/api/tests/test_health_core_version.py:
#
#   - a checkout with no version source must FAIL, not quietly answer with some
#     other checkout's `core-v*` tag;
#   - a garbled `biffo.core.json` must FAIL rather than fall back to a tag —
#     #811 records that fallback resolving to a 114-version-old fossil and being
#     read as authoritative.
#
# Both are safety properties about *the tree being deployed*, so the caller's
# position is the question, not this script's. Walking up answers the deploy
# case without giving that up: `api-service/` is inside the checkout, so the
# walk finds the root's authority and stops.
#
# The loop is bounded by `/`, and stopping at the first hit means a nested
# checkout resolves to the nearest authority rather than an outer one.
root=$PWD
while [ "$root" != / ] && [ ! -f "$root/biffo.core.json" ]; do
  root=$(dirname -- "$root")
done
if [ -f "$root/biffo.core.json" ]; then
  cd -- "$root"
fi

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

note() {
  [ "$QUIET" -eq 1 ] || printf '%s\n' "$1" >&2
}

# 1. An instance: biffo.core.json is the authority (ADR-0006).
#
# Parsed with node rather than grep/sed: this value ends up baked into a deployed
# artifact, and a regex that half-matches a reformatted file would bake in a wrong
# version silently. node is already a CI dependency here (ci.yml runs
# `node scripts/practices-monotonic.mjs`).
if [ -f biffo.core.json ]; then
  version=$(
    node -e '
      const raw = require("node:fs").readFileSync("biffo.core.json", "utf8")
      const parsed = JSON.parse(raw)
      if (typeof parsed.version !== "string" || !parsed.version.trim()) process.exit(3)
      process.stdout.write(parsed.version.trim())
    '
  ) || {
    echo "resolve-core-version: biffo.core.json exists but has no usable .version." >&2
    echo "  It is the authority for an instance's core version (ADR-0006), so a" >&2
    echo "  garbled one is a stop, not something to fall back from — #811 records" >&2
    echo "  what falling back cost last time (a 114-version-old fossil)." >&2
    exit 1
  }
  note "resolve-core-version: $version (from biffo.core.json — this is an instance)"
  printf '%s' "$version"
  exit 0
fi

# 2. The template: no biffo.core.json, so its version is its highest core-v* tag.
if git rev-parse --git-dir >/dev/null 2>&1; then
  tag=$(git tag -l 'core-v*' --sort=-v:refname | head -1 || true)
  if [ -n "$tag" ]; then
    version=${tag#core-v}
    note "resolve-core-version: $version (from tag $tag — this is the template)"
    printf '%s' "$version"
    exit 0
  fi
fi

echo "resolve-core-version: cannot determine a core version." >&2
echo "  Looked for biffo.core.json (an instance's authority) and a core-v* git tag" >&2
echo "  (the template's). Found neither." >&2
echo "" >&2
echo "  In CI the usual cause is tags: actions/checkout defaults to fetch-depth: 1," >&2
echo "  which fetches NO tags. Add 'fetch-tags: true' to this job's checkout." >&2
echo "" >&2
echo "  Failing here is deliberate. The alternative is a deployment whose /health" >&2
echo "  reports 'unknown' with nothing saying why, which is the failure #648 was" >&2
echo "  filed about in the first place." >&2
exit 1
