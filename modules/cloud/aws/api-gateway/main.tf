terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# Self-provisioned CMK for CloudWatch access-log encryption when no external key
# is passed. Referencing an empty var alone counts as "no encryption", so a real
# key resource is always the encryption backstop.
resource "aws_kms_key" "logs" {
  count                   = var.cloudwatch_kms_key_id == "" ? 1 : 0
  description             = "CMK for ${local.name_prefix} API Gateway access logs"
  enable_key_rotation     = true
  deletion_window_in_days = 7
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "EnableRoot", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }, Action = "kms:*", Resource = "*" },
      { Sid = "AllowCloudWatchLogs", Effect = "Allow", Principal = { Service = "logs.${data.aws_region.current.name}.amazonaws.com" }, Action = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"], Resource = "*", Condition = { ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:*" } } }
    ]
  })
  tags = var.tags
}

locals {
  log_kms_key_id = var.cloudwatch_kms_key_id != "" ? var.cloudwatch_kms_key_id : aws_kms_key.logs[0].arn
}

resource "aws_apigatewayv2_api" "main" {
  name          = "${local.name_prefix}-api"
  protocol_type = "HTTP"
  description   = "Biffo Core API - ${local.name_prefix}"
  tags          = var.tags

  # Applied by API Gateway itself, independent of the Lambda integration — this is
  # what puts CORS headers on responses the JWT authorizer rejects before invoking
  # Lambda (see the $default route below). FastAPI's CORSMiddleware only covers
  # requests that actually reach the Lambda.
  cors_configuration {
    allow_origins     = var.cors_origins
    allow_methods     = ["*"]
    allow_headers     = ["*"]
    allow_credentials = true
  }
}

# JWT authorizer backed by Cognito — validates Bearer tokens on all protected routes
resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.main.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${local.name_prefix}-cognito"

  jwt_configuration {
    audience = [var.cognito_client_id]
    issuer   = "https://cognito-idp.${var.aws_region}.amazonaws.com/${var.cognito_user_pool_id}"
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = var.lambda_function_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

# Health check — no auth required (public endpoint)
resource "aws_apigatewayv2_route" "health" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "GET /api/v1/health"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "NONE"
}

# OPTIONS preflight — no auth so CORS preflight is never blocked by the JWT authorizer.
# An explicit route takes precedence over the API's native cors_configuration for
# the same path, so this keeps forwarding preflight to Lambda/FastAPI's
# CORSMiddleware as before; cors_configuration on the API additionally covers
# non-OPTIONS requests the JWT authorizer rejects before they reach Lambda.
resource "aws_apigatewayv2_route" "options" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "OPTIONS /{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "NONE"
}

# Internal service-to-service surface (ADR-0009). Machine callers (ADR-0003
# plugins such as the orchestration engine) have no Cognito identity; they sign
# requests with SigV4 and are authorised by IAM here, not by the JWT authorizer.
# This route is more specific than $default, so it takes precedence for the
# /api/v1/internal/* prefix. It is inert until the Core API mounts an internal
# route AND a caller is granted execute-api:Invoke and added to the app-level
# allowlist (BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST).
resource "aws_apigatewayv2_route" "internal" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "ANY /api/v1/internal/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "AWS_IAM"
}

# Catch-all — all other routes require a valid Cognito JWT
resource "aws_apigatewayv2_route" "default" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "$default"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_stage" "main" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access_logs.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      ip               = "$context.identity.sourceIp"
      requestTime      = "$context.requestTime"
      httpMethod       = "$context.httpMethod"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      protocol         = "$context.protocol"
      responseLength   = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
    })
  }

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "access_logs" {
  name              = "/biffo/${local.name_prefix}/api-gateway"
  retention_in_days = 365
  kms_key_id        = local.log_kms_key_id
  tags              = var.tags
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}
