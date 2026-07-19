# Terraform for the orchestration engine plugin (ADR-0003 section 2 layout).
#
# `biffo plugin install orchestrator@<minor>` copies this terraform/ directory
# into the instance monorepo at modules/plugins/orchestrator/; the root config
# then instantiates it with a `module "plugin_orchestrator"` block (see
# infra/environments/<env>/main.tf's "Plugin modules" section for the shape).
#
# Adapted from modules/plugins/_template/main.tf. Differences: the engine is a
# system actor that (a) calls the Core API's IAM-authorized internal routes and
# (b) sends email via SES, so it attaches two extra least-privilege policies to
# its Lambda role. It stays NON-VPC (ADR-0002): it touches no database and needs
# outbound internet to reach the public Core API endpoint and SES.
#
# Relative module sources (../../cloud/aws/compute) resolve once this directory
# is copied to modules/plugins/orchestrator/ in the instance — exactly as the
# _template module documents.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

locals {
  name_prefix   = "${var.project_name}-${var.environment}"
  function_name = "${local.name_prefix}-plugin-${var.plugin_name}"
  # The engine is a generic forwarder (subscribe_all): a rule is always created,
  # matching every event so a new trigger needs no Terraform change (ADR-0010).
  has_subscriptions = var.subscribe_all || length(var.event_subscriptions) > 0
}

# Compute — the engine's Lambda. Non-VPC (no enable_vpc_access) so it can reach
# the public Core API endpoint and SES; it holds no db_credentials (ADR-0002).
module "function" {
  source = "../../cloud/aws/compute"

  project_name   = var.project_name
  environment    = var.environment
  function_name  = "plugin-${var.plugin_name}"
  handler        = var.handler
  runtime        = var.runtime
  memory_size    = var.memory_size
  timeout        = var.timeout
  event_bus_name = var.event_bus_name

  environment_variables = merge(
    {
      BIFFO_CORE_API_URL = var.core_api_url
      BIFFO_PLUGIN_NAME  = var.plugin_name
      # WhatsApp workflow action (empty = disabled). Account-level creds live
      # here, not in a workflow's action_config (which is stored in the DB).
      WHATSAPP_ACCESS_TOKEN    = var.whatsapp_access_token
      WHATSAPP_PHONE_NUMBER_ID = var.whatsapp_phone_number_id
    },
    var.environment_variables,
  )

  sqs_kms_key_id        = var.sqs_kms_key_id
  cloudwatch_kms_key_id = var.cloudwatch_kms_key_id
  tags                  = var.tags
}

# Extra least-privilege permissions unique to the engine, attached to the
# Lambda role the compute module created.
data "aws_iam_policy_document" "engine" {
  # Call the Core API's IAM-authorized internal routes only (ADR-0009).
  statement {
    sid       = "InvokeCoreInternalApi"
    effect    = "Allow"
    actions   = ["execute-api:Invoke"]
    resources = ["${var.core_api_execution_arn}/*/*/api/v1/internal/*"]
  }

  # Send email for the `email` action.
  statement {
    sid       = "SendEmail"
    effect    = "Allow"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = [var.ses_identity_arn]
  }
}

resource "aws_iam_role_policy" "engine" {
  name = "${local.function_name}-engine"
  # compute exposes the role via its ARN; derive the role name (last ARN
  # segment) since aws_iam_role_policy wants the name, not the ARN.
  role   = element(split("/", module.function.role_arn), length(split("/", module.function.role_arn)) - 1)
  policy = data.aws_iam_policy_document.engine.json
}

# Events — route bus events to the engine's Lambda. By default (subscribe_all)
# the rule matches every event; the engine forwards each to the Core API, which
# decides what runs from the enabled workflow definitions (ADR-0010).
resource "aws_cloudwatch_event_rule" "subscription" {
  count          = local.has_subscriptions ? 1 : 0
  name           = "${local.function_name}-events"
  description    = "Routes subscribed events to the ${var.plugin_name} plugin"
  event_bus_name = var.event_bus_name

  # subscribe_all → match every event on the bus: the engine forwards each to the
  # Core API, which matches enabled workflow definitions and decides what runs, so
  # adding a trigger is just a definition — no Terraform change (ADR-0010). Else a
  # single subscription uses a flat pattern and two or more are OR-ed: EventBridge
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
