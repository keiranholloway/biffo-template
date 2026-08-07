terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"
  bus_name    = "${local.name_prefix}-events"
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# Self-provisioned CMK for CloudWatch log encryption when no external key is
# passed. Referencing an empty var alone counts as "no encryption", so a real
# key resource is always the encryption backstop.
resource "aws_kms_key" "logs" {
  count                   = var.cloudwatch_kms_key_id == "" ? 1 : 0
  description             = "CMK for ${local.name_prefix} events CloudWatch logs"
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

resource "aws_cloudwatch_event_bus" "main" {
  name = local.bus_name
  tags = var.tags
}

# Archive for event replay — essential for debugging and recovery
resource "aws_cloudwatch_event_archive" "main" {
  name             = "${local.name_prefix}-archive"
  event_source_arn = aws_cloudwatch_event_bus.main.arn
  retention_days   = var.environment == "prod" ? 90 : 14
}

# Dead letter queue for events that fail all delivery attempts — encrypted at rest with KMS
resource "aws_sqs_queue" "dlq" {
  name                      = "${local.bus_name}-dlq"
  message_retention_seconds = 1209600 # 14 days
  kms_master_key_id         = var.sqs_kms_key_id != "" ? var.sqs_kms_key_id : null
  sqs_managed_sse_enabled   = var.sqs_kms_key_id == "" ? true : null
  tags                      = var.tags
}

resource "aws_sqs_queue_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.dlq.arn
      Condition = {
        ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_bus.main.arn }
      }
    }]
  })
}

# CloudWatch log group for all events — useful in dev/staging for visibility
resource "aws_cloudwatch_log_group" "events" {
  name              = "/biffo/${local.name_prefix}/events"
  retention_in_days = 365 # 1 year — satisfies CKV_AWS_338
  kms_key_id        = local.log_kms_key_id
  tags              = var.tags
}

resource "aws_cloudwatch_event_rule" "log_all" {
  count          = var.environment != "prod" ? 1 : 0
  name           = "${local.name_prefix}-log-all"
  description    = "Log all events in non-prod environments"
  event_bus_name = aws_cloudwatch_event_bus.main.name
  event_pattern  = jsonencode({ source = [{ prefix = "" }] })
  tags           = var.tags
}

resource "aws_cloudwatch_event_target" "log_all" {
  count          = var.environment != "prod" ? 1 : 0
  rule           = aws_cloudwatch_event_rule.log_all[0].name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  target_id      = "CloudWatchLogs"
  arn            = aws_cloudwatch_log_group.events.arn
}

# EventBridge cannot write to a log group without this, and says nothing when
# it cannot: the rule above stays ENABLED, `put-events` still returns
# FailedEntryCount 0, and the log group simply never gets a stream. On
# tabsii-platform dev that meant "log all events" had produced **zero** log
# streams since the environment was built, so the one tool for answering "was
# this event published?" had never worked and nobody could tell.
#
# A log-group resource policy is account-and-region scoped rather than attached
# to the group, which is why it is easy to omit: nothing about the log group,
# the rule or the target refers to it, and Terraform reports the whole stack as
# applied without it.
#
# Scoped to this rule via `aws:SourceArn` — the confused-deputy guard, same
# shape as the DLQ policy above. Created only where the rule is (non-prod),
# because granting a write nothing performs is the wider permission for no gain.
resource "aws_cloudwatch_log_resource_policy" "events_from_eventbridge" {
  count       = var.environment != "prod" ? 1 : 0
  policy_name = "${local.name_prefix}-events-from-eventbridge"

  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource  = "${aws_cloudwatch_log_group.events.arn}:*"
      Condition = {
        ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.log_all[0].arn }
      }
    }]
  })
}
