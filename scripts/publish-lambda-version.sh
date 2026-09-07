#!/usr/bin/env sh
#
# Publish a new Lambda version and move the `live` alias to point at it
# (biffo-template#1747).
#
# ## Why this exists
#
# Neither provisioned concurrency nor SnapStart can attach to `$LATEST` —
# both require a published, numbered version behind an alias. Every function
# the compute module provisions (modules/cloud/aws/compute/main.tf) now
# creates that alias once, at `terraform apply` time, pointed initially at
# `$LATEST`; this script is the other half, run on every code deploy, that
# actually moves it forward. It is also how a bad deploy gets rolled back —
# one `update-alias` call back to the previous version, no redeploy required.
#
# ## Ordering this depends on, but does not itself enforce
#
# The caller MUST have already confirmed the function's code update has
# finished applying — e.g. `aws lambda wait function-updated` — before
# calling this script. Publishing a version while a function is still
# mid-update either fails outright or publishes a version pinned to a
# half-applied configuration, which is worse than failing loudly. This
# script does not wait itself: deploy-app.yml already has a
# `function-updated` wait immediately before every call site, and repeating
# it here would just be a second copy of the same fact to keep in sync — the
# same reasoning as `_extract_detail`.
#
# ## Usage
#
#   sh scripts/publish-lambda-version.sh <function-name>
#
# PUBLISH_LAMBDA_VERSION_AWS — override the `aws` binary/wrapper (tests use
#                               this to point at a stub).
#
# ## Pruning (biffo-template#1957)
#
# Every published version keeps its own SnapStart snapshot cached and
# billing indefinitely once SnapStart is enabled (#1748) -- there is no
# AWS-side auto-cleanup for Python SnapStart. Right after the alias move
# above, this script also lists the function's published versions and
# deletes everything except `live` plus the last 3 prior versions (rollback
# depth), skipping `$LATEST` (unversioned, not deletable this way) and any
# version still referenced by an alias other than `live`. A cleanup failure
# -- for one version, or for the listing calls themselves -- is logged and
# never fails the script: a stuck old version costs money, a failed deploy
# costs more.
#
# Run this file's own tests: sh scripts/publish-lambda-version.test.sh

set -eu

AWS_BIN=${PUBLISH_LAMBDA_VERSION_AWS:-aws}
ALIAS_NAME=live
PRIOR_KEEP_COUNT=3 # rollback depth: kept alongside the live version itself

# prune_old_versions <function-name> <live-version> -- best-effort. Any
# failure to list versions/aliases, or to delete a given version, is logged
# to stderr and skipped/continued past -- this must never fail the deploy.
#
# `live` is passed in as the version this run just moved the alias to,
# rather than re-derived by assuming it's the highest published number --
# tying the keep-set to the version we know is actually live avoids any
# assumption about list-versions-by-function's ordering or consistency.
prune_old_versions() {
  fn=$1
  live=$2

  if ! all_versions=$("$AWS_BIN" lambda list-versions-by-function \
    --function-name "$fn" \
    --output text --query 'Versions[?Version!=`"$LATEST"`].Version' 2>/dev/null); then
    echo "::warning::publish-lambda-version.sh: failed to list versions for $fn; skipping prune." >&2
    return 0
  fi

  if [ -z "$all_versions" ]; then
    return 0
  fi

  if ! protected_versions=$("$AWS_BIN" lambda list-aliases \
    --function-name "$fn" \
    --output text --query "Aliases[?Name!=\`\"$ALIAS_NAME\"\`].FunctionVersion" 2>/dev/null); then
    echo "::warning::publish-lambda-version.sh: failed to list aliases for $fn; skipping prune." >&2
    return 0
  fi

  # The PRIOR_KEEP_COUNT largest version numbers strictly below `live` --
  # i.e. "the last 3 prior versions" (rollback depth), read off a
  # newest-first sort so the first ones strictly below `live` are exactly
  # those.
  prior_kept=""
  prior_kept_count=0
  for v in $(printf '%s\n' $all_versions | sort -rn); do
    if [ "$prior_kept_count" -ge "$PRIOR_KEEP_COUNT" ]; then
      break
    fi
    if [ "$v" -lt "$live" ]; then
      prior_kept="$prior_kept $v"
      prior_kept_count=$((prior_kept_count + 1))
    fi
  done

  for v in $all_versions; do
    if [ "$v" = "$live" ]; then
      continue # the live version itself -- keep
    fi

    keep=0
    for p in $prior_kept $protected_versions; do
      if [ "$p" = "$v" ]; then
        keep=1
        break
      fi
    done
    if [ "$keep" -eq 1 ]; then
      continue # last 3 prior, or referenced by a non-live alias -- keep
    fi

    if ! "$AWS_BIN" lambda delete-function \
      --function-name "$fn" \
      --qualifier "$v" >/dev/null 2>&1; then
      echo "::warning::publish-lambda-version.sh: failed to delete old version $v of $fn (SnapStart cache may linger); continuing." >&2
    fi
  done
}

FUNCTION_NAME=${1:-}
if [ -z "$FUNCTION_NAME" ]; then
  echo "::error::publish-lambda-version.sh: usage: publish-lambda-version.sh <function-name>" >&2
  exit 1
fi

VERSION=$("$AWS_BIN" lambda publish-version \
  --function-name "$FUNCTION_NAME" \
  --output text --query 'Version')

if [ -z "$VERSION" ]; then
  echo "::error::publish-lambda-version.sh: publish-version for $FUNCTION_NAME returned no version number." >&2
  exit 1
fi

"$AWS_BIN" lambda update-alias \
  --function-name "$FUNCTION_NAME" \
  --name "$ALIAS_NAME" \
  --function-version "$VERSION" \
  --output text --query 'AliasArn'

prune_old_versions "$FUNCTION_NAME" "$VERSION"

echo "Published $FUNCTION_NAME version $VERSION and moved alias '$ALIAS_NAME' to it."
