# Warm capacity (#1748): SnapStart on the published version behind the live
# alias (#1747), gated by enable_warm_capacity and OFF by default so no
# existing instance's cost or behaviour changes on upgrade. See README.md's
# "Warm capacity" section for why SnapStart was chosen over provisioned
# concurrency (biffo-template#1748's pinned decision comment, citing
# tabsii-platform M1's figures) — this file only proves the variable wires up
# correctly, not the mechanism choice itself.

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

run "warm_capacity_off_by_default" {
  command = apply

  # No variables{} override here — proves the module's own default, not a
  # test-supplied false, is what keeps every existing caller unchanged.
  assert {
    condition     = length(aws_lambda_function.main.snap_start) == 0
    error_message = "enable_warm_capacity must default to off: no snap_start block should be attached with no variable override"
  }
}

run "warm_capacity_off_explicit" {
  command = apply

  variables {
    enable_warm_capacity = false
  }

  assert {
    condition     = length(aws_lambda_function.main.snap_start) == 0
    error_message = "enable_warm_capacity = false must attach no snap_start block"
  }
}

run "warm_capacity_on" {
  command = apply

  variables {
    enable_warm_capacity = true
  }

  assert {
    condition     = length(aws_lambda_function.main.snap_start) == 1
    error_message = "enable_warm_capacity = true must attach exactly one snap_start block"
  }

  assert {
    condition     = aws_lambda_function.main.snap_start[0].apply_on == "PublishedVersions"
    error_message = "snap_start must apply only to published versions — SnapStart cannot attach to $LATEST, same constraint as the live alias (#1747)"
  }
}
