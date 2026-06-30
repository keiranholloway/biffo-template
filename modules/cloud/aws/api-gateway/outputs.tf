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
