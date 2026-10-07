# Stand-in for module.api_gateway: its execution_arn is a computed resource
# attribute, unknown at plan time under mock providers, as in a real instance.
resource "aws_apigatewayv2_api" "main" {
  name          = "stub"
  protocol_type = "HTTP"
}

output "execution_arn" { value = aws_apigatewayv2_api.main.execution_arn }
output "api_endpoint" { value = aws_apigatewayv2_api.main.api_endpoint }
