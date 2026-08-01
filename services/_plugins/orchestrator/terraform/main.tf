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
# Referenced IN PLACE by infra/environments/*/main.tf, as
# ../../../services/_plugins/orchestrator/terraform (issue #406). It used to be
# copied to modules/plugins/orchestrator/ like a third-party plugin, and that
# copy was never re-synced — so a core upgrade updated this file while Terraform
# kept applying a module frozen at install time. The relative module source
# below is therefore written for THIS location, not for a copy of it.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name_prefix   = "${var.project_name}-${var.environment}"
  function_name = "${local.name_prefix}-plugin-${var.plugin_name}"
  # The engine is a generic forwarder (subscribe_all): a rule is always created,
  # matching every event so a new trigger needs no Terraform change (ADR-0010).
  has_subscriptions = var.subscribe_all || length(var.event_subscriptions) > 0

  # SSM parameters the engine may read (WhatsApp credentials). Names are
  # configured with or without a leading slash; the ARN always has exactly one.
  whatsapp_parameters = compact([
    var.whatsapp_access_token_parameter,
    var.whatsapp_phone_number_id_parameter,
  ])
  whatsapp_parameter_arns = [
    for name in local.whatsapp_parameters :
    "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter/${trimprefix(name, "/")}"
  ]

  # Scheduled workflow actions (docs/implementation/0002-scheduled-workflow-actions,
  # ADR-0023): the engine's own Lambda ARN, needed as an env var so it can target
  # ITSELF when creating a one-time EventBridge Scheduler schedule. Constructed
  # rather than read from module.function.function_arn: that output is set by
  # THIS module's own `environment_variables` input below, and a resource
  # reading its own attribute back into its own config is a Terraform cycle.
  # The ARN is fully deterministic from name+account+region before the function
  # exists, so building it here avoids that cycle entirely.
  function_arn        = "arn:aws:lambda:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:function:${local.function_name}"
  schedule_group_name = "${local.function_name}-schedules"
}

# Compute — the engine's Lambda. Non-VPC (no enable_vpc_access) so it can reach
# the public Core API endpoint and SES; it holds no db_credentials (ADR-0002).
module "function" {
  source = "../../../../modules/cloud/aws/compute"

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
      # WhatsApp workflow action (empty = disabled). Only the SSM *parameter
      # names* travel as env vars; the engine fetches the values at cold start,
      # so the token stays out of Terraform state and out of the function config.
      # Account-level creds live here, not in a workflow's action_config (which
      # is stored in the DB).
      WHATSAPP_ACCESS_TOKEN_PARAMETER    = var.whatsapp_access_token_parameter
      WHATSAPP_PHONE_NUMBER_ID_PARAMETER = var.whatsapp_phone_number_id_parameter
      # Scheduled workflow actions (ADR-0023): where and how the engine creates
      # a one-time EventBridge Scheduler schedule for a delayed run's fire time.
      BIFFO_FUNCTION_ARN        = local.function_arn
      BIFFO_SCHEDULE_GROUP_NAME = aws_scheduler_schedule_group.engine.name
      BIFFO_SCHEDULER_ROLE_ARN  = aws_iam_role.scheduler_invocation.arn
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

  # Read the WhatsApp credentials at cold start — only the named parameters,
  # and only when the action is configured at all.
  dynamic "statement" {
    for_each = length(local.whatsapp_parameter_arns) > 0 ? [1] : []
    content {
      sid       = "ReadWhatsAppParameters"
      effect    = "Allow"
      actions   = ["ssm:GetParameter"]
      resources = local.whatsapp_parameter_arns
    }
  }

  # Decrypt the SecureString. Scoped to SSM via the kms:ViaService condition, so
  # this grants nothing outside a parameter fetch even on the account-default key.
  dynamic "statement" {
    for_each = length(local.whatsapp_parameter_arns) > 0 ? [1] : []
    content {
      sid       = "DecryptWhatsAppParameters"
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = ["*"]
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["ssm.${data.aws_region.current.name}.amazonaws.com"]
      }
    }
  }

  # Scheduled workflow actions (ADR-0023): create/delete/read the engine's own
  # one-time schedules, scoped to its own schedule group only.
  statement {
    sid    = "ManageOwnSchedules"
    effect = "Allow"
    actions = [
      "scheduler:CreateSchedule",
      "scheduler:DeleteSchedule",
      "scheduler:GetSchedule",
    ]
    resources = [
      "arn:aws:scheduler:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:schedule/${local.schedule_group_name}/*",
    ]
  }

  # CreateSchedule must pass the Scheduler-invocation role (below) to the
  # Scheduler service — scoped to that one role only, never a wildcard.
  statement {
    sid       = "PassSchedulerInvocationRole"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.scheduler_invocation.arn]
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

# ── Periodic tick, domain-agnostic (issue #1044) ─────────────────────────────
#
# Opt-in (empty schedule = no rule at all): this plugin has no periodic work
# of its own, unlike agent-runtime's reap sweep. What it offers instead is a
# generic trigger any deployment's own workflow definitions can subscribe to
# — mirrors agent-runtime's reap_schedule exactly, targeting the Lambda
# directly on the DEFAULT bus (EventBridge only supports schedule_expression
# there), with `input` synthesising the same BiffoEvent envelope
# create_event_handler expects, so the tick arrives through the identical
# dispatch path a real subscribed bus event takes and needs no second
# entrypoint in main.py. tenant_id is the ADR-0001 single-tenant sentinel,
# not a variable here (unlike agent-runtime's own tenant-scoped sweep): the
# tick itself is not tenant-scoped work, only whatever a subscribing
# definition chooses to do with it is, and that definition supplies its own
# tenant/brand scope via its own trigger config.
resource "aws_cloudwatch_event_rule" "tick_schedule" {
  count               = var.tick_schedule_expression == "" ? 0 : 1
  name                = "${local.function_name}-tick"
  description         = "Periodic domain-agnostic tick for ${var.plugin_name} (issue #1044)"
  schedule_expression = var.tick_schedule_expression

  tags = var.tags
}

resource "aws_cloudwatch_event_target" "tick_schedule" {
  count     = var.tick_schedule_expression == "" ? 0 : 1
  rule      = aws_cloudwatch_event_rule.tick_schedule[0].name
  target_id = "${var.plugin_name}-tick"
  arn       = module.function.function_arn

  input = jsonencode({
    source        = "biffo.orchestrator"
    "detail-type" = "orchestrator.tick"
    detail = {
      schema_version = "1.0"
      tenant_id      = "default"
      payload        = {}
    }
  })
}

resource "aws_lambda_permission" "tick_schedule" {
  count         = var.tick_schedule_expression == "" ? 0 : 1
  statement_id  = "AllowEventBridgeTickInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.function.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.tick_schedule[0].arn
}

# ── Scheduled workflow actions (docs/implementation/0002-scheduled-workflow-actions, ADR-0023) ──
#
# One EventBridge Scheduler one-time schedule per delayed run, created by the
# engine itself at claim time (boto3 `scheduler.create_schedule`, not
# Terraform — there is no per-run resource to declare here, only the
# mechanism). `ActionAfterCompletion = "DELETE"` on each schedule means no
# Terraform-managed cleanup is needed for the schedules themselves.

# Namespaces this plugin's schedules, separate from any other plugin's.
resource "aws_scheduler_schedule_group" "engine" {
  name = local.schedule_group_name
  tags = var.tags
}

# EventBridge Scheduler invokes a target using an IAM role it assumes for that
# purpose — not a Lambda resource-based permission the way an EventBridge Rule
# target needs (Rules and Scheduler use different invocation models: a Rule's
# target is invoked as the `events.amazonaws.com` principal directly, so the
# Lambda side needs `aws_lambda_permission`; Scheduler always assumes an
# explicit IAM role and that role's own policy is the entire authorization —
# see `aws_lambda_permission.subscription` above for the contrasting case).
# The `aws:SourceArn`/`aws:SourceAccount` condition is AWS's documented
# confused-deputy guard: only a schedule in THIS group, in THIS account, may
# assume this role.
data "aws_iam_policy_document" "scheduler_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["${aws_scheduler_schedule_group.engine.arn}/*"]
    }
  }
}

resource "aws_iam_role" "scheduler_invocation" {
  name               = "${local.function_name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_trust.json
  tags               = var.tags
}

# Scoped to this Lambda only — Scheduler can invoke nothing else with this role.
data "aws_iam_policy_document" "scheduler_invocation" {
  statement {
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = [module.function.function_arn]
  }
}

resource "aws_iam_role_policy" "scheduler_invocation" {
  name   = "${local.function_name}-scheduler-invoke"
  role   = aws_iam_role.scheduler_invocation.id
  policy = data.aws_iam_policy_document.scheduler_invocation.json
}
