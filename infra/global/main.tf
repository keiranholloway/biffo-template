terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }

  backend "s3" {}
}

# ACM certificates for CloudFront must be provisioned in us-east-1.
# Route 53 is a global service (endpoint in us-east-1) so both live here.
provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = var.project_name
      ManagedBy = "terraform"
    }
  }
}

locals {
  manage_route53 = var.dns_mode == "managed-route53"

  # The set of names the wildcard certificate validates: the apex and its
  # wildcard. These are derived purely from var.domain (a known input), so the
  # for_each below has statically-known keys.
  cert_validation_domains = [var.domain, "*.${var.domain}"]

  # Values are looked up from the certificate at apply time. Only the map KEYS
  # need to be known during plan/import; the values may be known-after-apply.
  cert_validation_options = {
    for dvo in aws_acm_certificate.wildcard.domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }
}

resource "aws_route53_zone" "main" {
  count = local.manage_route53 ? 1 : 0

  name = var.domain
}

resource "aws_acm_certificate" "wildcard" {
  domain_name               = var.domain
  subject_alternative_names = ["*.${var.domain}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# for_each is keyed off static domain names derived from var.domain rather than
# off aws_acm_certificate.wildcard.domain_validation_options. The latter is a
# set that is "known only after apply", which makes `terraform import` fail with
# "Invalid for_each argument": import evaluates the whole config graph before any
# apply runs, and unlike apply it has no -target to scope that evaluation, so the
# cert is never planned and its validation options stay unknown (#330). The map
# VALUES still come from the certificate — only the keys must be known here.
resource "aws_route53_record" "cert_validation" {
  for_each = local.manage_route53 ? toset(local.cert_validation_domains) : toset([])

  allow_overwrite = true
  name            = local.cert_validation_options[each.key].name
  records         = [local.cert_validation_options[each.key].record]
  ttl             = 60
  type            = local.cert_validation_options[each.key].type
  zone_id         = aws_route53_zone.main[0].zone_id
}

resource "aws_acm_certificate_validation" "wildcard" {
  count = local.manage_route53 ? 1 : 0

  certificate_arn         = aws_acm_certificate.wildcard.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# --- biffo-template#1529: error-status-demote Lambda@Edge function --------
#
# Fixes the CDN replacing every API 403/404 JSON body with the portal's SPA
# shell (modules/cloud/aws/cdn/main.tf's `custom_error_response`, which is
# distribution-wide and cannot be scoped away from the API behaviours). See
# `error_status_restore_lambda_arn` in that module's variables.tf and
# error-status-demote.js's own header for the full mechanism.
#
# Lambda@Edge functions must be created in us-east-1 REGARDLESS of the
# distribution's own region — the same constraint the wildcard ACM
# certificate above already lives here for — so the function is created in
# this global, always-us-east-1 root and its qualified ARN threaded into each
# environment as an input variable, exactly like `acm_certificate_arn`
# already is.
#
# The deployment package is a COMMITTED zip
# (modules/cloud/aws/cdn/error-status-demote.zip), not a
# `data "archive_file"`: `deploy-infra.yml` runs `plan` and `apply` as
# separate jobs on separate runners, and a zip written to disk by a data
# source at plan time does not exist on the apply runner when the AWS
# provider reads `filename` from local disk at apply time — the exact
# failure `modules/cloud/aws/compute/main.tf`'s placeholder.zip documents
# (#1457). `cli/src/lib/cdn-error-status-demote-zip-freshness.test.ts` guards
# the committed zip against drifting from the source it must match.
data "aws_iam_policy_document" "error_status_demote_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type = "Service"
      # Lambda@Edge functions assume this role from BOTH services: lambda.
      # amazonaws.com for the function itself, edgelambda.amazonaws.com for
      # CloudFront's replication of it out to edge locations. Omitting either
      # fails distribution association or edge replication, not creation —
      # so a missing one would not surface until the first real request.
      identifiers = ["lambda.amazonaws.com", "edgelambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "error_status_demote" {
  name               = "${var.project_name}-error-status-demote"
  assume_role_policy = data.aws_iam_policy_document.error_status_demote_trust.json
}

# Basic execution only (CloudWatch Logs) — this function reads/writes a
# status code and one header and nothing else, so it needs no other AWS
# permission. Lambda@Edge writes its logs to a REGIONAL log group in each
# edge location that invokes it (named /aws/lambda/us-east-1.<function>),
# not a single log group this role could scope more tightly to up front.
resource "aws_iam_role_policy_attachment" "error_status_demote_logs" {
  role       = aws_iam_role.error_status_demote.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "error_status_demote" {
  function_name = "${var.project_name}-error-status-demote"
  role          = aws_iam_role.error_status_demote.arn
  handler       = "error-status-demote.handler"
  # nodejs22.x, not nodejs20.x: as of this writing nodejs20.x is already past
  # its security-patch cutoff and blocks new function creation within weeks
  # — verified against AWS's current deprecation schedule rather than
  # assumed, since Lambda@Edge's supported-runtime list is a moving target
  # and this module has no CI signal that would catch a stale choice here.
  runtime     = "nodejs22.x"
  memory_size = 128
  # Origin-response triggers allow up to 30s; this function does no I/O and
  # returns in well under 1s, but Lambda@Edge does not allow environment
  # variables or VPC config to tune around a cold start, so a slightly
  # generous ceiling costs nothing and avoids a cold-start timeout on the
  # very first invocation in a new edge location.
  timeout = 5
  # publish = true is REQUIRED, not conventional: Lambda@Edge associations
  # pin to one immutable numeric version — CloudFront will not follow
  # $LATEST — so aws_lambda_function.error_status_demote.qualified_arn
  # (output below) only exists at all when this publishes a version.
  publish = true

  filename         = "${path.module}/../../modules/cloud/aws/cdn/error-status-demote.zip"
  source_code_hash = filebase64sha256("${path.module}/../../modules/cloud/aws/cdn/error-status-demote.zip")

  depends_on = [aws_iam_role_policy_attachment.error_status_demote_logs]
}
