terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

data "aws_caller_identity" "current" {}

locals {
  name_prefix         = "${var.project_name}-${var.environment}"
  portal_bucket       = "${local.name_prefix}-portal-${data.aws_caller_identity.current.account_id}"
  logs_bucket         = "${local.name_prefix}-logs-${data.aws_caller_identity.current.account_id}"
  artifacts_bucket    = "${local.name_prefix}-artifacts-${data.aws_caller_identity.current.account_id}"
  plugin_media_bucket = "${local.name_prefix}-plugin-media-${data.aws_caller_identity.current.account_id}"
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

# Lambda deployment artifacts (#994)
#
# `update-function-code --zip-file` sends the package INLINE, base64-encoded at
# ~1.33x against a ~70MB request cap. tabsii-platform outgrew it at 60.3MB zipped
# / ~80.2MB as a request body, and the size guard failed the deploy outright --
# so the instance could not ship at all and its /health sat 173 releases behind.
# Uploading through S3 instead raises the ceiling to 250MB unzipped.
#
# Deliberately NOT the portal bucket, which is the obvious place and is wrong:
# the portal is CloudFront-served, so a Lambda zip written there would publish
# the application's own source. This one is private, and stays private.
resource "aws_s3_bucket" "artifacts" {
  bucket = local.artifacts_bucket
  # Deployment packages are rebuilt from source by definition -- nothing here is
  # the only copy of anything, so a teardown must not be blocked by them.
  force_destroy = true
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# No versioning, unlike the portal bucket: every object is keyed by commit SHA and
# is therefore already immutable, so versions would only accumulate cost. The
# lifecycle rule is what keeps this from growing without bound -- Lambda reads the
# object once at update-function-code time and never again, so 14 days is
# generous for the only thing it is ever needed for afterwards, which is a human
# inspecting what actually shipped.
resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    id     = "expire-deployment-packages"
    status = "Enabled"
    filter {}
    expiration { days = 14 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

resource "aws_s3_bucket_logging" "artifacts" {
  bucket        = aws_s3_bucket.artifacts.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "artifacts-access-logs/"
}

# Portal static assets bucket
resource "aws_s3_bucket" "portal" {
  bucket        = local.portal_bucket
  force_destroy = true
  tags          = var.tags
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

# Plugin object storage (ADR-0021, biffo-template#1437).
#
# ONE bucket for every installed plugin, isolated by key prefix:
#
#   plugins/<plugin>/<tenant_id>/<uuid4>/<filename>
#
# One bucket rather than one per plugin, and no per-plugin resources at all,
# because isolation is enforced where it can actually be enforced: Core derives
# `<plugin>` from the caller's VERIFIED ServicePrincipal, never from the request.
# Given that, there is nothing per-plugin left to provision — so installing a
# plugin requires no Terraform change whatsoever, which is the strongest reading
# of ADR-0021's "a user-facing plugin provisions no infrastructure".
#
# Created unconditionally rather than behind a flag. An empty bucket costs
# nothing, and the alternative is a capability that exists in the manifest and
# fails at runtime in exactly the environments nobody remembered to enable it in
# — the shape of failure this estate keeps paying for.
resource "aws_s3_bucket" "plugin_media" {
  bucket        = local.plugin_media_bucket
  force_destroy = true
  tags          = var.tags
}

# Fully private. Objects are reached ONLY by presigned URL minted by Core, which
# is what lets the bucket stay blocked while still serving a browser directly.
resource "aws_s3_bucket_public_access_block" "plugin_media" {
  bucket                  = aws_s3_bucket.plugin_media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "plugin_media" {
  bucket = aws_s3_bucket.plugin_media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Deliberately NOT versioned, unlike the portal bucket.
#
# Keys carry a uuid4, so an object is never overwritten — there is no second
# version for versioning to keep, and enabling it would only accumulate delete
# markers nobody reads. The two instance buckets that DO version
# (tabsii's fdd-evidence) do so because they carry Object Lock for 7-year
# retention; this capability deliberately does not model retention at all, and
# should not until something needs it.

# The browser PUTs bytes straight to S3 from a page served on the platform
# domain, so the bucket must permit that origin. GET is included because a
# presigned GET is also a cross-origin browser request.
resource "aws_s3_bucket_cors_configuration" "plugin_media" {
  bucket = aws_s3_bucket.plugin_media.id
  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST", "HEAD"]
    allowed_origins = var.plugin_media_cors_origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_logging" "plugin_media" {
  bucket        = aws_s3_bucket.plugin_media.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "plugin-media-access-logs/"
}

# Abandoned multipart uploads are invisible in the console and billed anyway —
# the same trap the artifacts bucket already guards against.
resource "aws_s3_bucket_lifecycle_configuration" "plugin_media" {
  bucket = aws_s3_bucket.plugin_media.id
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}
