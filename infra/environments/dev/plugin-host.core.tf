# The shared plugin host (ADR-0021) — ONE Lambda that runs every installed
# user-facing plugin's API, behind the shared API Gateway at /api/v1/plugins/*.
# Template-owned core infrastructure (like plugins.core.tf): it replaces ADR-0018's
# per-plugin Lambda / API Gateway / CloudFront hosting with a single shared runtime.
#
# It holds NO database access (ADR-0002) — it calls Core's /api/v1/internal/*
# over SigV4 (ADR-0009), asserting each plugin's identity (ADR-0021 §1a) — and is
# NOT the Core process (ADR-0013 §3). Its code (host + installed plugins' packages
# + a generated installed-plugins.json) is pushed by the Deploy Application step,
# so Terraform ships a placeholder and ignores the code (the compute module does).
module "plugin_host" {
  source = "../../../modules/cloud/aws/compute"

  project_name  = var.project_name
  environment   = local.environment
  function_name = "plugin-host"
  handler       = "plugin_host.app.handler"
  runtime       = "python3.13"
  memory_size   = 512
  timeout       = 30

  event_bus_name = module.events.event_bus_name

  # The founder gate reads the shared-Cognito config from the environment
  # (SDK CognitoConfig.from_env); no DB credentials are injected (ADR-0002).
  environment_variables = {
    BIFFO_COGNITO_JWKS_JSON    = data.http.cognito_jwks.response_body
    BIFFO_COGNITO_USER_POOL_ID = module.auth.user_pool_id
    BIFFO_COGNITO_CLIENT_ID    = module.auth.client_id
    BIFFO_COGNITO_REGION       = var.aws_region
    BIFFO_CORE_API_URL         = module.api_gateway.api_endpoint
    BIFFO_PLUGINS_ROOT         = "/var/task/services"
  }

  tags = local.tags
}

# The host signs SigV4 calls to Core's IAM-authorized internal routes only
# (ADR-0009), exactly like a first-party plugin's engine role.
data "aws_iam_policy_document" "plugin_host_core_calls" {
  statement {
    sid       = "InvokeCoreInternal"
    effect    = "Allow"
    actions   = ["execute-api:Invoke"]
    resources = ["${module.api_gateway.execution_arn}/*/*/api/v1/internal/*"]
  }
}

resource "aws_iam_role_policy" "plugin_host_core_calls" {
  name   = "core-internal-calls"
  role   = module.plugin_host.role_name
  policy = data.aws_iam_policy_document.plugin_host_core_calls.json
}

# The user-facing plugin ingress: ANY /api/v1/plugins/{proxy+} on the shared API
# Gateway routes to the host. The gateway's Cognito JWT authorizer authenticates
# the founder here (same authorizer as every other route, via the module output);
# the host then enforces each plugin's declared group (ADR-0011) and dispatches to
# its router. This route is more specific than the API's $default route (which
# targets Core), so plugin traffic reaches the host and everything else Core.
#
# Defined here, not in the api-gateway module, so all of the host's wiring lives in
# this one template-owned file and rides `biffo core upgrade` — no instance has to
# edit its user-owned root module to provision the host.
resource "aws_apigatewayv2_integration" "plugin_host" {
  api_id                 = module.api_gateway.api_id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.plugin_host.function_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "plugins" {
  api_id             = module.api_gateway.api_id
  route_key          = "ANY /api/v1/plugins/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.plugin_host.id}"
  authorization_type = "JWT"
  authorizer_id      = module.api_gateway.cognito_authorizer_id
}

resource "aws_lambda_permission" "plugin_host_api_gateway" {
  statement_id  = "AllowAPIGatewayInvokePluginHost"
  action        = "lambda:InvokeFunction"
  function_name = module.plugin_host.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${module.api_gateway.execution_arn}/*/*"
}
