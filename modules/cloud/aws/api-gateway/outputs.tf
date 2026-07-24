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

# The shared Cognito JWT authorizer, so the template-owned plugin-host.core.tf can
# attach the /api/v1/plugins/{proxy+} route (ADR-0021) to this API with the same
# founder authentication as every other route, without editing the user-owned root
# module.
output "cognito_authorizer_id" {
  value = aws_apigatewayv2_authorizer.cognito.id
}
