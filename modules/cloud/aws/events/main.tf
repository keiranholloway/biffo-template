terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"
  bus_name    = "${local.name_prefix}-events"
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

# Dead letter queue for events that fail all delivery attempts
resource "aws_sqs_queue" "dlq" {
  name                      = "${local.bus_name}-dlq"
  message_retention_seconds = 1209600 # 14 days
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
  retention_in_days = var.environment == "prod" ? 30 : 7
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
