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
  # `plugin_host_environment` first so a core key can never be silently
  # overridden by instance config — a plugin shadowing BIFFO_CORE_API_URL
  # would break every plugin on the host, not just its own.
  environment_variables = merge(var.plugin_host_environment, {
    BIFFO_COGNITO_JWKS_JSON    = data.http.cognito_jwks.response_body
    BIFFO_COGNITO_USER_POOL_ID = module.auth.user_pool_id
    BIFFO_COGNITO_CLIENT_ID    = module.auth.client_id
    BIFFO_COGNITO_REGION       = var.aws_region
    BIFFO_CORE_API_URL         = module.api_gateway.api_endpoint
    BIFFO_PLUGINS_ROOT         = "/var/task/services"
  })

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

# admin_ingress's built UI shell (index.html + hashed assets/*) is served from
# INSIDE the same /<name>/admin path space as its gated JSON API — a deliberate
# M2 tradeoff to avoid provisioning per-plugin CloudFront/S3 for a handful of
# trusted admins (unlike a founder-facing user_frontend, which gets its own
# unauthenticated CloudFront distribution). But the blanket JWT authorizer
# above covers ALL of /api/v1/plugins/{proxy+}, and a plain browser navigation
# can never attach a custom Authorization header — so without these two more
# specific, unauthenticated routes, the shell's own index.html/JS/CSS could
# never load in the first place, for anyone (biffo-template#627). API Gateway
# v2 prefers a route with more literal path segments over a less specific
# catch-all matching the same prefix, so these win for exactly the shell paths
# they name and leave everything else on the blanket JWT route above. The
# plugin-host Lambda's own group_gate independently exempts these same paths
# from its token check (mount.py's _is_public_admin_asset) — its JSON API
# routes stay fully gated either way.
resource "aws_apigatewayv2_route" "plugin_admin_shell_root" {
  api_id = module.api_gateway.api_id
  # No trailing slash: API Gateway v2 rejects a route_key with an empty final
  # path segment ("Part of the given route key path is empty", confirmed by a
  # real failed apply) -- there is no way to express the trailing-slash form
  # literally. Whether this alone also serves a browser's GET .../admin/
  # (with the slash) needs confirming against the real deployed API.
  route_key          = "GET /api/v1/plugins/{name}/admin"
  target             = "integrations/${aws_apigatewayv2_integration.plugin_host.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_route" "plugin_admin_shell_assets" {
  api_id             = module.api_gateway.api_id
  route_key          = "GET /api/v1/plugins/{name}/admin/assets/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.plugin_host.id}"
  authorization_type = "NONE"
}
