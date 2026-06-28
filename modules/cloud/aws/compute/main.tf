terraform {
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.0" }
  }
}

# Minimal placeholder zip — Terraform creates this automatically during plan.
# The CI/CD pipeline overwrites the function code on every deploy;
# this only exists so the Lambda resource can be created on first apply.
data "archive_file" "placeholder" {
  type        = "zip"
  output_path = "${path.module}/placeholder.zip"
  source {
    content  = "def handler(event, context):\n    pass\n"
    filename = "handler.py"
  }
}

locals {
  name_prefix   = "${var.project_name}-${var.environment}"
  function_name = "${local.name_prefix}-${var.function_name}"
}

# Dead letter queue for failed invocations
resource "aws_sqs_queue" "dlq" {
  name                      = "${local.function_name}-dlq"
  message_retention_seconds = 1209600 # 14 days
  tags                      = var.tags
}

# Security group — outbound to DB SG handled at the DB module level
resource "aws_security_group" "lambda" {
  name        = "${local.function_name}-sg"
  description = "Lambda function security group for ${local.function_name}"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${local.function_name}-sg" })
}

resource "aws_cloudwatch_log_group" "function" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.environment == "prod" ? 90 : 14
  tags              = var.tags
}

# Least-privilege execution role — no AdministratorAccess, no PowerUser
data "aws_iam_policy_document" "lambda_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.function_name}-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "vpc_access" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "lambda_permissions" {
  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = ["${aws_cloudwatch_log_group.function.arn}:*"]
  }

  statement {
    sid    = "DLQAccess"
    effect = "Allow"
    actions = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }

  dynamic "statement" {
    for_each = var.db_credentials_secret_arn != "" ? [1] : []
    content {
      sid    = "DBSecretsAccess"
      effect = "Allow"
      actions = ["secretsmanager:GetSecretValue"]
      resources = [var.db_credentials_secret_arn]
    }
  }

  dynamic "statement" {
    for_each = var.event_bus_name != "" ? [1] : []
    content {
      sid    = "EventBridgePublish"
      effect = "Allow"
      actions = ["events:PutEvents"]
      resources = ["arn:aws:events:*:*:event-bus/${var.event_bus_name}"]
    }
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "biffo-lambda-policy"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_permissions.json
}

resource "aws_lambda_function" "main" {
  function_name = local.function_name
  role          = aws_iam_role.lambda.arn
  handler       = var.handler
  runtime       = var.runtime
  memory_size   = var.memory_size
  timeout       = var.timeout

  filename         = data.archive_file.placeholder.output_path
  source_code_hash = data.archive_file.placeholder.output_base64sha256

  dead_letter_config {
    target_arn = aws_sqs_queue.dlq.arn
  }

  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = merge(
      var.environment_variables,
      {
        POWERTOOLS_SERVICE_NAME = local.function_name
        POWERTOOLS_LOG_LEVEL    = var.environment == "prod" ? "WARNING" : "INFO"
      }
    )
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [
    aws_cloudwatch_log_group.function,
    aws_iam_role_policy_attachment.vpc_access,
    aws_iam_role_policy.lambda,
  ]

  lifecycle {
    # Code is managed by the CI/CD pipeline — Terraform only manages config
    ignore_changes = [filename, source_code_hash, last_modified]
  }

  tags = var.tags
}
