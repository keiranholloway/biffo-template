terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

# Minimal placeholder zip — a COMMITTED file, deliberately not generated.
#
# It exists only so the Lambda resource can be created on first apply; the
# CI/CD pipeline overwrites the function code on every deploy and this resource
# ignores changes to it thereafter.
#
# It used to be produced by a `data "archive_file"` writing to
# ${path.module}/placeholder.zip. That is evaluated at PLAN time, and
# deploy-infra.yml runs plan and apply as separate jobs on separate self-hosted
# runners, transporting only `tfplan`. So the file existed on the plan runner
# and not on the apply runner, and creating a Lambda failed with
# "reading ZIP file ...: no such file or directory" — see #1457.
#
# It survived a long time because it bites ONLY a function being created: an
# existing one is unchanged, so `filename` is never re-read. Every routine
# deploy was green. It was also intermittent, because two jobs landing on the
# same runner share that runner's checkout — which makes a re-run look like a
# fix and teaches exactly the wrong lesson.
#
# Committing the bytes removes the plan/apply coupling rather than transporting
# it. The contents are irrelevant, so generating them bought nothing.

locals {
  name_prefix   = "${var.project_name}-${var.environment}"
  function_name = "${local.name_prefix}-${var.function_name}"
}

# Dead letter queue for failed invocations — encrypted at rest with KMS
resource "aws_sqs_queue" "dlq" {
  name                      = "${local.function_name}-dlq"
  message_retention_seconds = 1209600 # 14 days
  kms_master_key_id         = var.sqs_kms_key_id
  tags                      = var.tags
}

# Security group — only created when this function is attached to a VPC
# (var.enable_vpc_access). A sibling with no DB of its own (ADR-0002/
# ADR-0007) should generally leave this false.
resource "aws_security_group" "lambda" {
  count       = var.enable_vpc_access ? 1 : 0
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
  retention_in_days = 365 # 1 year — satisfies CKV_AWS_338
  kms_key_id        = var.cloudwatch_kms_key_id
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
  count      = var.enable_vpc_access ? 1 : 0
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
    sid       = "DLQAccess"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "sibling-lambda-policy"
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

  filename         = "${path.module}/placeholder.zip"
  source_code_hash = filebase64sha256("${path.module}/placeholder.zip")

  dead_letter_config {
    target_arn = aws_sqs_queue.dlq.arn
  }

  dynamic "vpc_config" {
    for_each = var.enable_vpc_access ? [1] : []
    content {
      subnet_ids         = var.private_subnet_ids
      security_group_ids = [aws_security_group.lambda[0].id]
    }
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
    ignore_changes = [filename, source_code_hash]
  }

  tags = var.tags
}
