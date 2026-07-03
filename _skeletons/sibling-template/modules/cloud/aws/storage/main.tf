terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

data "aws_caller_identity" "current" {}

locals {
  name_prefix = "${var.project_name}-${var.environment}"
  site_bucket = "${local.name_prefix}-site-${data.aws_caller_identity.current.account_id}"
  logs_bucket = "${local.name_prefix}-logs-${data.aws_caller_identity.current.account_id}"
}

# Access logs bucket
resource "aws_s3_bucket" "logs" {
  bucket        = local.logs_bucket
  force_destroy = true
  tags          = var.tags
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

# This sibling's static frontend export — served via the PARENT project's
# CloudFront distribution as a new origin/ordered_cache_behavior (ADR-0007;
# see modules/cloud/aws/cdn/main.tf in the parent repo). The bucket policy
# trusting that distribution's ARN is deliberately NOT in this module — it
# lives in infra/main.tf, parameterized by var.parent_cloudfront_distribution_arn,
# because this module has no way to know that ARN (it belongs to a
# distribution this repo doesn't own or create).
resource "aws_s3_bucket" "site" {
  bucket        = local.site_bucket
  force_destroy = true
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_logging" "site" {
  bucket        = aws_s3_bucket.site.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "site-access-logs/"
}
