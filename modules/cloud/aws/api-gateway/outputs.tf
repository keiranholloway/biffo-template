output "api_id" {
  value = aws_apigatewayv2_api.main.id
}

output "api_endpoint" {
  description = "Base URL of the HTTP API — set as NEXT_PUBLIC_API_URL in the portal build"
  value       = trimsuffix(aws_apigatewayv2_stage.main.invoke_url, "/")
}

output "execution_arn" {
  value = aws_apigatewayv2_api.main.execution_arn
}

# Host of the HTTP API (no scheme, no path) — the CloudFront origin domain for the
# shared plugin-host route (ADR-0021), wired into module.cdn.plugin_host_api_domain.
output "api_domain" {
  value = replace(aws_apigatewayv2_api.main.api_endpoint, "https://", "")
}

# The shared Cognito JWT authorizer, so the template-owned plugin-host.core.tf can
# attach the /api/v1/plugins/{proxy+} route (ADR-0021) to this API with the same
# founder authentication as every other route, without editing the user-owned root
# module.
output "cognito_authorizer_id" {
  value = aws_apigatewayv2_authorizer.cognito.id
}

# CONTRACT for any OTHER aws_apigatewayv2_integration targeting the SAME Lambda
# this module was given as var.lambda_function_arn (biffo-template#1900). This
# module's aws_lambda_permission.api_gateway is scoped to
# qualifier = local.lambda_alias_name (#1747) — a Lambda alias carries its own
# resource-based policy, separate from the unqualified function's, so a
# permission added without a qualifier does not extend to invocations made via
# a qualified ARN and vice versa. An integration_uri pointed at the raw,
# unqualified function ARN therefore has ZERO invoke permission the moment this
# module's permission exists, and fails closed with a generic API Gateway 500
# that neither this module's nor the caller's `terraform plan`/`apply` can see
# (confirmed live: this took down tabsii-platform's entire unauthenticated
# public API, 11 routes, until a human noticed).
#
# Env-owned Terraform (infra/environments/<env>/*.tf, which core-manifest.json
# excludes from template sync — see plugin-host.core.tf's own integration for
# the established pattern of wiring a route onto this API from outside this
# module) MUST use this output as integration_uri when it targets the same
# Lambda, never the compute module's raw function_arn output and never a
# same-named "live" alias re-derived by convention: this is the ARN THIS
# module's own permission actually requires, independent of how any other
# module happens to name its own alias.
output "lambda_integration_uri" {
  description = "Alias-qualified ARN of the Lambda this API's own aws_lambda_permission grants invoke access to. Any other aws_apigatewayv2_integration targeting the SAME function (the one passed in as var.lambda_function_arn) MUST use this output as its integration_uri — see the comment above for why the raw function ARN silently loses invoke permission."
  value       = local.lambda_alias_arn
}
