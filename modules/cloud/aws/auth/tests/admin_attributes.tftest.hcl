# Disagreement guard for issue #1476.
#
# The AWS provider's aws_cognito_user resource strips the `custom:` namespace
# when it reads an attribute back into state (flattenAttributeTypes), but a
# plain key-equality diff against a CONFIG that still declares the prefixed
# form never matches — so a config author who writes `"custom:foo" = ...`
# here causes Terraform to write the attribute and delete it again on the
# very next apply, oscillating forever (CloudTrail-confirmed: 23 deletions in
# biffo-platform, 50+ in tabsii-platform). The provider's own write path
# re-prefixes an UNPREFIXED key on the way out, so the fix is simply never to
# declare the prefixed form in this file.
#
# This is a static assertion on OUR config, not a simulation of the
# provider's read/diff bug — mock_provider fills in a fully-known plan
# without reproducing AWS's real state-refresh behaviour, so it cannot
# reproduce the oscillation itself. What it CAN do, and what actually
# prevents a regression, is fail the moment anyone reintroduces a
# `custom:`-prefixed key into aws_cognito_user.admin.attributes — which is
# the entire mechanism of the bug.

mock_provider "aws" {}

variables {
  project_name  = "biffo"
  environment   = "test"
  domain_prefix = "biffo-test"
  admin_email   = "admin@example.com"
}

run "admin_attributes_have_no_custom_prefix" {
  command = plan

  assert {
    condition     = alltrue([for k in keys(aws_cognito_user.admin.attributes) : !startswith(k, "custom:")])
    error_message = "aws_cognito_user.admin.attributes must not declare custom:-prefixed keys — the provider strips the prefix when it reads state back, so a prefixed key here never matches state and the attribute is written then deleted on every other apply (issue #1476). Declare the unprefixed form (e.g. tenant_id, not custom:tenant_id); the provider re-prefixes it on write."
  }

  assert {
    condition     = contains(keys(aws_cognito_user.admin.attributes), "tenant_id")
    error_message = "aws_cognito_user.admin.attributes should declare tenant_id (unprefixed) per ADR-0001's multi-tenant seam"
  }
}
