#!/usr/bin/env bash
# Helper to configure the GitHub Actions → AWS OIDC trust manually.
# The biffo CLI does this automatically via `biffo init`.
# Use this script only if you need to reconfigure OIDC in an existing account.
set -euo pipefail

: "${AWS_ACCOUNT_ID:?Set AWS_ACCOUNT_ID}"
: "${AWS_REGION:?Set AWS_REGION}"
: "${GITHUB_ORG:?Set GITHUB_ORG}"
: "${GITHUB_REPO:?Set GITHUB_REPO}"
: "${PROJECT_NAME:?Set PROJECT_NAME}"

ROLE_NAME="biffo-github-actions-${PROJECT_NAME}"
OIDC_PROVIDER_URL="https://token.actions.githubusercontent.com"

echo "Creating OIDC provider..."
aws iam create-open-id-connect-provider \
  --url "$OIDC_PROVIDER_URL" \
  --client-id-list "sts.amazonaws.com" \
  --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1" \
  --region "$AWS_REGION" 2>/dev/null || echo "OIDC provider already exists"

OIDC_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"

# GitHub emits one of two OIDC subject formats depending on the account:
#   legacy:        repo:<org>/<repo>:ref:refs/heads/main
#   ID-qualified:  repo:<org>@<ownerId>/<repo>@<repoId>:ref:refs/heads/main
# The ID-qualified ("immutable unique") form appends the numeric owner and repo
# IDs so the claim survives renames. Trusting only the legacy form denies every
# assume-role on accounts issuing the other (issue #271), so pin both. IDs come
# from the GitHub API; if it is unreachable we fall back to the legacy pattern
# alone rather than wildcarding — a lookup failure must never widen the policy.
echo "Resolving GitHub repository IDs..."
REPO_JSON=$(curl -sf \
  ${GITHUB_TOKEN:+-H "Authorization: Bearer ${GITHUB_TOKEN}"} \
  "https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}" || true)
if command -v jq >/dev/null 2>&1; then
  OWNER_ID=$(printf '%s' "$REPO_JSON" | jq -r '.owner.id // empty')
  REPO_ID=$(printf '%s' "$REPO_JSON" | jq -r '.id // empty')
else
  # No jq: the repo's own "id" is the first id in the payload; the owner's is the
  # one inside the "owner" object ([^}] keeps the match from escaping that object).
  REPO_ID=$(printf '%s' "$REPO_JSON" | grep -o '"id"[[:space:]]*:[[:space:]]*[0-9]*' | head -1 | grep -o '[0-9]*$')
  OWNER_ID=$(printf '%s' "$REPO_JSON" | sed -n 's/.*"owner"[[:space:]]*:[[:space:]]*{[^}]*"id"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p')
fi

if [[ -n "$OWNER_ID" && -n "$REPO_ID" ]]; then
  SUBJECTS="\"repo:${GITHUB_ORG}/${GITHUB_REPO}:*\", \"repo:${GITHUB_ORG}@${OWNER_ID}/${GITHUB_REPO}@${REPO_ID}:*\""
  echo "  Trusting subjects: repo:${GITHUB_ORG}/${GITHUB_REPO}:* and repo:${GITHUB_ORG}@${OWNER_ID}/${GITHUB_REPO}@${REPO_ID}:*"
else
  SUBJECTS="\"repo:${GITHUB_ORG}/${GITHUB_REPO}:*\""
  echo "  WARNING: could not resolve repo IDs — trusting the legacy subject only."
  echo "  If deploys fail with sts:AssumeRoleWithWebIdentity AccessDenied, set"
  echo "  GITHUB_TOKEN and re-run this script (see issue #271)."
fi

TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "${OIDC_ARN}" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike":   { "token.actions.githubusercontent.com:sub": [ ${SUBJECTS} ] }
    }
  }]
}
EOF
)

echo "Creating IAM role: ${ROLE_NAME}..."
ROLE_ARN=$(aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document "$TRUST_POLICY" \
  --query 'Role.Arn' \
  --output text)

echo ""
echo "OIDC role ARN: ${ROLE_ARN}"
echo ""
echo "Add this to GitHub Secrets as BIFFO_OIDC_ROLE_ARN"
