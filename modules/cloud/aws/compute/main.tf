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

  # Database credential secrets this function may read — the master, and the
  # least-privilege application role when the environment provisions one (#253).
  db_secret_arns = compact([
    var.db_credentials_secret_arn,
    var.app_db_credentials_secret_arn,
  ])

  # AWS Signer profile names allow [0-9A-Za-z_] only and cap name_prefix at 38
  # characters. `<project>-<environment>-<function>` clears that easily once a
  # project name is more than a few characters — e.g. a 39-char function name
  # yields a 40-char prefix and terraform fails the whole apply on validation,
  # before touching any resource.
  #
  # Truncate when it doesn't fit, appending a short digest of the full function
  # name so two functions whose names share a prefix can't collide onto the same
  # profile. 29 + 1 + 8 = 38.
  _signer_name_prefix = replace("${local.function_name}_", "-", "_")
  signer_name_prefix = (
    length(local._signer_name_prefix) <= 38
    ? local._signer_name_prefix
    : format(
      "%s_%s",
      substr(local._signer_name_prefix, 0, 29),
      substr(sha256(local.function_name), 0, 8),
    )
  )
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# Self-provisioned CMK for CloudWatch log encryption when no external key is
# passed. Referencing an empty var alone counts as "no encryption" to Checkov
# and to AWS, so a real key resource is always the encryption backstop.
resource "aws_kms_key" "logs" {
  count                   = var.cloudwatch_kms_key_id == "" ? 1 : 0
  description             = "CMK for ${local.function_name} CloudWatch logs"
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

# Dead letter queue for failed invocations — encrypted at rest with KMS
resource "aws_sqs_queue" "dlq" {
  name                      = "${local.function_name}-dlq"
  message_retention_seconds = 1209600 # 14 days
  kms_master_key_id         = var.sqs_kms_key_id != "" ? var.sqs_kms_key_id : null
  sqs_managed_sse_enabled   = var.sqs_kms_key_id == "" ? true : null
  tags                      = var.tags
}

# Security group — outbound to DB SG handled at the DB module level.
# Only created when this function is attached to a VPC (var.enable_vpc_access).
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
  kms_key_id        = local.log_kms_key_id
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

  # The Core API reads two DB credentials: the master (migrations, db-init,
  # ddl-import — they create and alter objects) and the least-privilege
  # application role the request path connects as (#253). Scoped to the exact
  # ARNs supplied; app_db_credentials_secret_arn is optional so a deployment
  # that has not yet re-applied the database module still gets the master.
  dynamic "statement" {
    for_each = length(local.db_secret_arns) > 0 ? [1] : []
    content {
      sid       = "DBSecretsAccess"
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.db_secret_arns
    }
  }

  dynamic "statement" {
    for_each = var.event_bus_name != "" ? [1] : []
    content {
      sid       = "EventBridgePublish"
      effect    = "Allow"
      actions   = ["events:PutEvents"]
      resources = ["arn:aws:events:*:*:event-bus/${var.event_bus_name}"]
    }
  }

  # Read additional, function-specific secrets (e.g. the PR-signer's GitHub App
  # key, ADR-0008). Scoped to the exact ARNs supplied — never secret-wildcard.
  dynamic "statement" {
    for_each = length(var.readable_secret_arns) > 0 ? [1] : []
    content {
      sid       = "ReadableSecretsAccess"
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = var.readable_secret_arns
    }
  }

  # Invoke specific other Lambdas over IAM (e.g. the Core API invoking the
  # isolated PR-signer, ADR-0008). Scoped to the exact function ARNs supplied.
  dynamic "statement" {
    for_each = length(var.invoke_function_arns) > 0 ? [1] : []
    content {
      sid       = "InvokeFunctions"
      effect    = "Allow"
      actions   = ["lambda:InvokeFunction"]
      resources = var.invoke_function_arns
    }
  }

  # Cognito admin operations for user management (add users, edit attributes,
  # assign to groups, suspend/remove, reset password). Scoped to the single
  # user pool ARN — never pool-wildcard, keeping the least-privilege posture
  # (no AdministratorAccess).
  dynamic "statement" {
    for_each = var.cognito_user_pool_arn != "" ? [1] : []
    content {
      sid    = "CognitoUserAdmin"
      effect = "Allow"
      actions = [
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminUpdateUserAttributes",
        "cognito-idp:AdminDisableUser",
        "cognito-idp:AdminEnableUser",
        "cognito-idp:AdminDeleteUser",
        "cognito-idp:AdminAddUserToGroup",
        "cognito-idp:AdminRemoveUserFromGroup",
        "cognito-idp:AdminListGroupsForUser",
        "cognito-idp:AdminUserGlobalSignOut",
        "cognito-idp:AdminResetUserPassword",
        "cognito-idp:ListUsers",
        "cognito-idp:ListGroups",
      ]
      resources = [var.cognito_user_pool_arn]
    }
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "biffo-lambda-policy"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_permissions.json
}

# Code-signing config — attached with a NON-BREAKING (Warn) policy so the CI
# pipeline's unsigned update-function-code deploys still succeed while satisfying
# the code-signing check.
resource "aws_signer_signing_profile" "lambda" {
  platform_id = "AWSLambda-SHA384-ECDSA"
  name_prefix = local.signer_name_prefix
}

resource "aws_lambda_code_signing_config" "main" {
  allowed_publishers {
    signing_profile_version_arns = [aws_signer_signing_profile.lambda.version_arn]
  }
  policies {
    untrusted_artifact_on_deployment = "Warn" # Warn (NOT Enforce): CI deploys unsigned zips
  }
}

resource "aws_lambda_function" "main" {
  function_name           = local.function_name
  role                    = aws_iam_role.lambda.arn
  code_signing_config_arn = aws_lambda_code_signing_config.main.arn
  handler                 = var.handler
  runtime                 = var.runtime
  memory_size             = var.memory_size
  timeout                 = var.timeout

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

# Neither provisioned concurrency nor SnapStart can attach to $LATEST — both
# require a published, numbered version behind an alias (#1747). This is the
# stable name the API Gateway module's integration targets and CI/CD moves
# forward on every deploy; it is also how a bad deploy is rolled back in one
# `update-alias` API call instead of a redeploy.
#
# Created here, pointed at $LATEST (the placeholder code, on first apply) —
# deploy-app.yml is what actually moves it, via `aws lambda publish-version`
# + `aws lambda update-alias` after every `update-function-code`
# (scripts/publish-lambda-version.sh). `function_version` is therefore
# ignored after creation: without that, the next `terraform apply` would see
# the alias still declared as pointing at "$LATEST" in HCL, diverging from
# whatever version CI/CD has since moved it to, and would move it BACK —
# silently undoing every deploy's alias promotion the next time infrastructure
# is applied.
resource "aws_lambda_alias" "live" {
  name             = "live"
  description      = "Stable alias CI/CD moves to the newest published version after every deploy (#1747) — the API Gateway integration and any provisioned-concurrency/SnapStart config target this, never $LATEST."
  function_name    = aws_lambda_function.main.function_name
  function_version = "$LATEST"

  lifecycle {
    ignore_changes = [function_version]
  }
}
