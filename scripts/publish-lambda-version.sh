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
# Run this file's own tests: sh scripts/publish-lambda-version.test.sh

set -eu

AWS_BIN=${PUBLISH_LAMBDA_VERSION_AWS:-aws}
ALIAS_NAME=live

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

echo "Published $FUNCTION_NAME version $VERSION and moved alias '$ALIAS_NAME' to it."
