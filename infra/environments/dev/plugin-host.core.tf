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
