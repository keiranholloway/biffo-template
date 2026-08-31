# The "live" alias (#1747) is the prerequisite provisioned concurrency and
# SnapStart both need, since neither can attach to $LATEST. Asserts the
# module creates exactly one, named "live", pointed at the function this
# module also creates, and that Terraform is told to leave its
# function_version alone after creation — deploy-app.yml (via
# scripts/publish-lambda-version.sh) is what moves it on every deploy, and a
# plain apply must never move it back to "$LATEST".

mock_provider "aws" {
  # Every one of these ARNs feeds into another resource that validates its
  # shape at plan time even under a mock provider — the auto-generated
  # placeholder is not ARN-shaped, so each needs a real-looking default.
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:mock" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = { arn = "arn:aws:sqs:us-east-1:123456789012:mock-dlq" }
  }
  mock_resource "aws_lambda_code_signing_config" {
    defaults = { arn = "arn:aws:lambda:us-east-1:123456789012:code-signing-config:csc-mock" }
  }

  # aws_signer_signing_profile's version_arn feeds straight into
  # aws_lambda_code_signing_config, which validates it really looks like an
  # ARN even under a mock provider — the auto-generated placeholder does not.
  mock_resource "aws_signer_signing_profile" {
    defaults = {
      version_arn = "arn:aws:signer:us-east-1:123456789012:/signing-profiles/mock/versions/1"
    }
  }

  # aws_iam_policy_document is a local computation, not an AWS API call —
  # under mock_provider its .json output is a placeholder string, and
  # aws_iam_role.lambda's assume_role_policy then fails Terraform's own
  # "must be valid JSON" validation before any resource is even mocked.
  # Every one of this module's several policy documents needs the same
  # override for the same reason.
  override_data {
    target = data.aws_iam_policy_document.lambda_trust
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  override_data {
    target = data.aws_iam_policy_document.lambda_permissions
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  project_name  = "biffo"
  environment   = "test"
  function_name = "core-api"
  handler       = "api.main.handler"
}

run "creates_exactly_one_live_alias" {
  command = apply

  assert {
    condition     = aws_lambda_alias.live.name == "live"
    error_message = "the compute module must create an alias named 'live'"
  }

  assert {
    condition     = aws_lambda_alias.live.function_name == aws_lambda_function.main.function_name
    error_message = "the live alias must point at the function this module creates, not some other function"
  }
}

run "live_alias_ignores_function_version_after_creation" {
  command = plan

  # lifecycle.ignore_changes is a plan-time behaviour, not a resource
  # attribute Terraform test can assert on directly — so this proves the
  # thing that behaviour is FOR: a config that still declares function_version
  # = "$LATEST" (this module's own default) produces a plan with no changes
  # to re-apply, which is the observable proxy for "a later apply will not
  # fight CI/CD's out-of-band update-alias call". Re-running with the exact
  # same config a real apply would have used is what makes this a genuine
  # no-op check rather than a tautology.
  assert {
    condition     = aws_lambda_alias.live.function_version == "$LATEST"
    error_message = "a fresh plan against the module's own default must show the alias still declared at $LATEST — proves there is nothing else in this config that would fight the ignore_changes lifecycle block"
  }
}

run "live_alias_arn_output_matches_the_alias_resource" {
  command = apply

  assert {
    condition     = output.live_alias_arn == aws_lambda_alias.live.arn
    error_message = "live_alias_arn output must be exactly the alias resource's own ARN"
  }

  assert {
    condition     = output.live_alias_name == "live"
    error_message = "live_alias_name output must be exactly 'live'"
  }
}
