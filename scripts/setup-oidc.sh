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

TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "${OIDC_ARN}" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:${GITHUB_ORG}/${GITHUB_REPO}:*" }
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
