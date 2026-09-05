# The Lambda proxy integration must target the "live" alias, not the
# unqualified function ARN (#1747) — neither provisioned concurrency nor
# SnapStart can attach to $LATEST. And the invoke permission API Gateway
# needs to call that alias must carry a matching qualifier: an
# aws_lambda_permission added without one does not extend to invocations made
# via a qualified (alias/version) ARN, so a real deploy without it would fail
# with AccessDenied at request time despite `terraform apply` succeeding.

mock_provider "aws" {
  # Both feed straight into another resource that validates its shape at plan
  # time even under a mock provider — the auto-generated placeholder is not
  # ARN-shaped.
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:mock" }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = { execution_arn = "arn:aws:execute-api:us-east-1:123456789012:mockapi" }
  }
}

variables {
  project_name         = "biffo"
  environment          = "test"
  lambda_function_arn  = "arn:aws:lambda:us-east-1:123456789012:function:biffo-test-core-api"
  lambda_function_name = "biffo-test-core-api"
  cognito_user_pool_id = "us-east-1_mockpool"
  cognito_client_id    = "mockclientid"
  aws_region           = "us-east-1"
  cors_origins         = ["https://example.com"]
}

run "integration_targets_the_live_alias_arn" {
  command = apply

  assert {
    condition     = aws_apigatewayv2_integration.lambda.integration_uri == "${var.lambda_function_arn}:live"
    error_message = "the integration must target <function_arn>:live, not the unqualified function ARN"
  }
}

run "permission_carries_a_matching_qualifier" {
  command = apply

  assert {
    condition     = aws_lambda_permission.api_gateway.qualifier == "live"
    error_message = "the invoke permission must be qualified for the 'live' alias — an unqualified permission does not cover invocations made via a qualified ARN"
  }

  assert {
    condition     = aws_lambda_permission.api_gateway.function_name == var.lambda_function_name
    error_message = "the permission must still target the function by name (qualifier is separate from function_name)"
  }
}

# biffo-template#1900: the module must expose the exact ARN its own permission
# requires, so an env-owned aws_apigatewayv2_integration targeting the same
# Lambda from OUTSIDE this module (core-manifest.json excludes
# infra/environments/ from template sync) has a named, correct contract to
# use instead of the raw function_arn — the shape that took tabsii-platform's
# public API down.
run "lambda_integration_uri_output_matches_the_permissions_qualifier" {
  command = apply

  assert {
    condition     = output.lambda_integration_uri == "${var.lambda_function_arn}:live"
    error_message = "lambda_integration_uri must expose the alias-qualified ARN this module's own aws_lambda_permission requires"
  }
}
