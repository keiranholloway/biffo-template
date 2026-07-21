# Terraform for the agent runtime plugin (ADR-0014 §1, ADR-0003 section 2 layout).
#
# The agent framework is first-party platform capability, not a marketplace
# plugin: this directory is template-owned and reaches instances via
# `biffo core upgrade`. It is plugin-*shaped* only because the runtime is a
# Lambda reacting to an event, exactly like the orchestration engine's dispatch
# worker (ADR-0013's characterisation, quoted in ADR-0014 §1).
#
# Adapted from _skeletons/plugin-template/terraform/. Three differences, each
# forced by what an LLM call is:
#
#   1. It is sized for a model call, not a webhook. The skeleton's 30s timeout
#      would kill a run mid-turn; see var.timeout. ADR-0014 §8 records the
#      platform ceiling this sits inside: "A Lambda invocation is capped at 15
#      minutes, so a multi-turn loop must either finish inside one invocation or
#      be resumable across several."
#   2. It reads one secret — the OpenRouter API key — so it attaches a
#      least-privilege secretsmanager:GetSecretValue policy scoped to that one
#      secret ARN. The key is never a Terraform-committed literal and never an
#      environment variable holding the value itself.
#   3. Its event subscription is specific, not a catch-all: only
#      biffo.core/agent.run.requested. The orchestrator subscribes to everything
#      because it is a generic forwarder; this runtime has exactly one trigger
#      (ADR-0014 §4), so subscribe_all stays false.
#
# It stays NON-VPC (ADR-0002): it touches no database and needs outbound
# internet for the Core API endpoint and OpenRouter.
#
# Relative module sources (../../cloud/aws/compute) resolve once this directory
# is copied to modules/plugins/agent-runtime/ in the instance — exactly as the
# _template module documents.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

locals {
  name_prefix   = "${var.project_name}-${var.environment}"
  function_name = "${local.name_prefix}-plugin-${var.plugin_name}"
  # A rule is created when the plugin subscribes to specific events, or when it
  # is a generic forwarder that reacts to every event (subscribe_all).
  has_subscriptions = var.subscribe_all || length(var.event_subscriptions) > 0
  # Grant Core API access only when the root config told us which API to scope
  # it to. Empty (the default) => the plugin never calls Core, so no grant.
  grants_core_api_access = var.core_api_execution_arn != ""
  # Likewise for the OpenRouter key: no secret ARN, no grant. The runtime then
  # fails its first run with a clear "no OpenRouter credential" error rather
  # than holding a permission it cannot use.
  grants_secret_access = var.openrouter_api_key_secret_arn != ""
}

# Compute — the plugin's Lambda function.
module "function" {
  source = "../../cloud/aws/compute"

  project_name       = var.project_name
  environment        = var.environment
  function_name      = "plugin-${var.plugin_name}"
  handler            = var.handler
  runtime            = var.runtime
  memory_size        = var.memory_size
  timeout            = var.timeout
  enable_vpc_access  = var.enable_vpc_access
  vpc_id             = var.vpc_id
  private_subnet_ids = var.private_subnet_ids
  event_bus_name     = var.event_bus_name

  # No db_credentials_secret_arn — see the ADR-0002 note above.
  environment_variables = merge(
    {
      BIFFO_CORE_API_URL = var.core_api_url
      BIFFO_PLUGIN_NAME  = var.plugin_name
      # The ARN of the secret holding the OpenRouter key — never the key. The
      # runtime resolves it once per warm container (src/agent_runtime/
      # openrouter.py) so the value never appears in the function's
      # configuration, where anyone with lambda:GetFunction could read it.
      OPENROUTER_API_KEY_SECRET_ARN = var.openrouter_api_key_secret_arn
      # ADR-0014 §8 hard stops, deployment-wide ceilings a worker definition can
      # only narrow. The wall clock sits inside var.timeout with room to spare
      # so a run that exhausts its budget can still POST its failure to Core
      # (§5) instead of being killed mid-report.
      AGENT_RUNTIME_MAX_SECONDS = tostring(var.run_timeout_seconds)
      AGENT_RUNTIME_MAX_TURNS   = tostring(var.max_turns_ceiling)
    },
    var.environment_variables,
  )

  sqs_kms_key_id        = var.sqs_kms_key_id
  cloudwatch_kms_key_id = var.cloudwatch_kms_key_id
  tags                  = var.tags
}

# Events — subscribe the plugin's Lambda to its declared event_subscriptions
# on the shared bus. Each subscription is matched as its own source +
# detail-type pair via `$or`, rather than independent `source`/`detail-type`
# arrays, to avoid EventBridge matching the cross product of unrelated
# source/detail-type combinations when a plugin subscribes to more than one
# event.
resource "aws_cloudwatch_event_rule" "subscription" {
  count          = local.has_subscriptions ? 1 : 0
  name           = "${local.function_name}-events"
  description    = "Routes subscribed events to the ${var.plugin_name} plugin"
  event_bus_name = var.event_bus_name

  # subscribe_all → match every event on the bus (a generic forwarder; the plugin
  # decides what to do, so new triggers need no Terraform change — ADR-0010). Else
  # a single subscription uses a flat pattern and two or more are OR-ed: EventBridge
  # rejects a `$or` with fewer than 2 elements ("There must have at least 2 Objects
  # in $or relationship"), so the single-subscription case must not use it.
  # jsonencode is applied inside each branch so the conditional's arms are all
  # strings — a `cond ? {a} : {b}` on differently-shaped objects is an "Inconsistent
  # conditional result types" error at apply (validate misses it).
  event_pattern = var.subscribe_all ? jsonencode({
    source = [{ prefix = "" }]
    }) : length(var.event_subscriptions) == 1 ? jsonencode({
    source        = [var.event_subscriptions[0].source]
    "detail-type" = [var.event_subscriptions[0].detail_type]
    }) : jsonencode({
    "$or" = [
      for s in var.event_subscriptions : {
        source        = [s.source]
        "detail-type" = [s.detail_type]
      }
    ]
  })

  tags = var.tags
}

resource "aws_cloudwatch_event_target" "subscription" {
  count          = local.has_subscriptions ? 1 : 0
  rule           = aws_cloudwatch_event_rule.subscription[0].name
  event_bus_name = var.event_bus_name
  target_id      = "${var.plugin_name}-lambda"
  arn            = module.function.function_arn
}

resource "aws_lambda_permission" "subscription" {
  count         = local.has_subscriptions ? 1 : 0
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.function.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.subscription[0].arn
}

# Core API access (ADR-0009) — the plugin->Core auth path.
#
# ADR-0002 forbids this Lambda from touching the database, so anything it needs
# from the platform it gets over HTTPS from the Core API. The Core API's
# internal routes (/api/v1/internal/*) are IAM-authorized, not Cognito-JWT, so
# the plugin authenticates by SigV4-signing with this Lambda role — see
# biffo_plugin_sdk.SignedCoreClient, which BiffoPluginBase uses by default. No
# bearer token, no shared secret, nothing to rotate.
#
# Scoped to the /api/v1/internal/* prefix on one API, never the whole API.
data "aws_iam_policy_document" "core_api" {
  count = local.grants_core_api_access ? 1 : 0

  statement {
    sid       = "InvokeCoreInternalApi"
    effect    = "Allow"
    actions   = ["execute-api:Invoke"]
    resources = ["${var.core_api_execution_arn}/*/*/api/v1/internal/*"]
  }
}

resource "aws_iam_role_policy" "core_api" {
  count = local.grants_core_api_access ? 1 : 0
  name  = "${local.function_name}-core-api"
  # compute exposes the role via its ARN; derive the role name (last ARN
  # segment) since aws_iam_role_policy wants the name, not the ARN.
  role   = element(split("/", module.function.role_arn), length(split("/", module.function.role_arn)) - 1)
  policy = data.aws_iam_policy_document.core_api[0].json
}

# The OpenRouter API key (ADR-0014 §1: "Provider access sits behind the runtime's
# own client"). Read at runtime from Secrets Manager, so the credential is never
# in Terraform state as a literal, never in the Lambda's environment, and
# rotatable without a deploy.
data "aws_iam_policy_document" "openrouter_secret" {
  count = local.grants_secret_access ? 1 : 0

  statement {
    sid       = "ReadOpenRouterApiKey"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.openrouter_api_key_secret_arn]
  }
}

resource "aws_iam_role_policy" "openrouter_secret" {
  count = local.grants_secret_access ? 1 : 0
  name  = "${local.function_name}-openrouter"
  role  = element(split("/", module.function.role_arn), length(split("/", module.function.role_arn)) - 1)

  policy = data.aws_iam_policy_document.openrouter_secret[0].json
}
