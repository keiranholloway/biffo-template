#!/usr/bin/env sh
#
# Run the Biffo CLI, from whichever copy is correct for this repo.
#
#   - **Template** (no `biffo.core.json`): the local `cli/` workspace, through
#     tsx. The template develops the CLI, so its own CI has to exercise the code
#     in the working tree — running the published package here would test the
#     last release instead of the change under review, and a broken guard would
#     go green and only fail after publish.
#
#   - **Instance** (`biffo.core.json` present): the published package, pinned to
#     the core version this instance is actually on. Instances no longer carry
#     `cli/` at all: it is 31k lines of a scaffolding tool they never develop
#     and never deploy, and shipping it meant the template's own test suite ran
#     in every tenant's CI — where a failure could not be fixed by the repo it
#     failed in.
#
# Pinning to `biffo.core.json` rather than `@latest` keeps the guards in step
# with the core the instance runs. An instance mid-upgrade is checked by the
# version it is upgrading from, which is the one whose rules its tree follows.
#
# That last sentence is why the version is read from `HEAD` and not the working
# tree (#667). `biffo core upgrade --apply` rewrites `biffo.core.json` to the
# TARGET version before committing, so by the time the `commit-msg` hook runs
# the working tree already names a version that, by definition, may not be
# published yet:
#
#     npm error notarget No matching version found for @biffo/cli@0.133.1
#     husky - commit-msg script failed (code 1)
#
# The upgrade then cannot be committed at all, and `--no-verify` does not help
# because CI runs the same check. Reading HEAD judges the commit by the rules
# the tree currently follows, and decouples committing an upgrade from whether
# the target has reached npm yet.
set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"

if [ -f biffo.core.json ]; then
  # The committed record first. Falls through to the working tree when there is
  # no HEAD yet (a fresh `biffo init`, before the first commit) or when the file
  # is newly added and not yet in any commit.
  version=$(git show HEAD:biffo.core.json 2>/dev/null |
    node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version" 2>/dev/null || echo '')
  if [ -z "$version" ] || [ "$version" = 'undefined' ]; then
    version=$(node -p "require('./biffo.core.json').version" 2>/dev/null || echo '')
  fi
  if [ -z "$version" ] || [ "$version" = 'undefined' ]; then
    echo "biffo.sh: biffo.core.json is present but carries no readable version." >&2
    exit 2
  fi
  exec npx --yes "@biffo/cli@$version" "$@"
fi

exec pnpm --filter @biffo/cli exec tsx src/index.ts "$@"
