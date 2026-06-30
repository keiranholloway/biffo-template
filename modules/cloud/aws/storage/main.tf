terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

data "aws_caller_identity" "current" {}

locals {
  name_prefix   = "${var.project_name}-${var.environment}"
  portal_bucket = "${local.name_prefix}-portal-${data.aws_caller_identity.current.account_id}"
  logs_bucket   = "${local.name_prefix}-logs-${data.aws_caller_identity.current.account_id}"
}

# Access logs bucket
resource "aws_s3_bucket" "logs" {
  bucket = local.logs_bucket
  tags   = var.tags
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Portal static assets bucket
resource "aws_s3_bucket" "portal" {
  bucket = local.portal_bucket
  tags   = var.tags
}

resource "aws_s3_bucket_public_access_block" "portal" {
  bucket                  = aws_s3_bucket.portal.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "portal" {
  bucket = aws_s3_bucket.portal.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "portal" {
  bucket = aws_s3_bucket.portal.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_logging" "portal" {
  bucket        = aws_s3_bucket.portal.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "portal-access-logs/"
}

