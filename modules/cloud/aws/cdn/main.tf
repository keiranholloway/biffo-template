terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"

  # CloudFront path_pattern "<name>/*" does NOT match the bare "/<name>"
  # (no trailing slash, nothing after it) — only "/<name>/" or
  # "/<name>/anything". Since that's exactly how a human types or links to
  # a sibling (baseurl.com/<name>, no trailing slash), each sibling needs a
  # SECOND, exact-match behavior for the bare name too. A single looser
  # pattern like "<name>*" (no slash) would also match unrelated paths that
  # merely start with the same characters (e.g. "crm-billing" matching
  # "crm*") — two precise patterns per sibling is the correct fix, not a
  # broader wildcard.
  sibling_cache_behaviors = flatten([
    for s in var.sibling_origins : [
      { name = s.name, path_pattern = s.name },
      { name = s.name, path_pattern = "${s.name}/*" },
    ]
  ])

  # ROUTING INVERSION (issue #306). The portal is strictly the admin console: it
  # serves /admin and /login, and the root path is reserved for the user's
  # application sibling. So the portal moves from default_cache_behavior to
  # explicit ordered behaviors, and default_cache_behavior becomes the root's.
  #
  # Two patterns per prefix, for exactly the reason spelled out above the
  # siblings: "admin/*" does NOT match the bare "/admin", which is how a human
  # types it.
  #
  # These four are the complete set the portal needs:
  #
  #   admin    — the bare /admin entry point
  #   admin/*  — every admin route, its RSC payloads, AND every static asset.
  #              apps/portal/next.config.ts sets `assetPrefix: '/admin'`, so the
  #              exported HTML references /admin/_next/* rather than /_next/*.
  #              That is the entire point of the assetPrefix: it vacates
  #              /_next/* for the root sibling, which has an empty basePath and
  #              would otherwise claim the identical URL prefix from a
  #              *different* S3 origin — one path, two origins, which CloudFront
  #              cannot disambiguate.
  #   login    — the bare /login entry point
  #   login/*  — /login/ and its RSC payload
  #
  # There is deliberately NO "_next/*" behavior here. That prefix now belongs to
  # whoever serves the root, and adding it back would re-create the collision.
  portal_cache_behaviors = ["admin", "admin/*", "login", "login/*"]

  # Portal behaviors first so they are evaluated ahead of any sibling's. In
  # practice the patterns are disjoint — `sibling_origins` forbids the reserved
  # names "admin" and "login" (see variables.tf), and a duplicate path_pattern
  # would fail the for_each below with a duplicate-key error rather than
  # silently shadowing a route.
  ordered_cache_behaviors = concat(
    [for p in local.portal_cache_behaviors : {
      path_pattern     = p
      target_origin_id = "S3-${var.portal_bucket_name}"
    }],
    [for b in local.sibling_cache_behaviors : {
      path_pattern     = b.path_pattern
      target_origin_id = "sibling-${b.name}"
    }],
  )
}

# Rewrites clean URLs to their index.html equivalents so Next.js static export
# routes work on direct access and page refresh. Without this, S3 returns 403
# for /admin and CloudFront falls back to /index.html (the wrong page).
resource "aws_cloudfront_function" "rewrite" {
  name    = "${local.name_prefix}-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-EOF
    function handler(event) {
      var uri = event.request.uri;
      if (!uri.includes('.')) {
        event.request.uri = uri.replace(/\/?$/, '/index.html');
      }
      return event.request;
    }
  EOF
}

resource "aws_cloudfront_origin_access_control" "portal" {
  name                              = "${local.name_prefix}-portal-oac"
  description                       = "OAC for ${local.name_prefix} portal S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Dedicated log-delivery bucket for CloudFront access logs (CKV_AWS_86).
resource "aws_s3_bucket" "cf_logs" {
  #checkov:skip=CKV_AWS_18:This IS the log-delivery bucket; logging it to itself is circular.
  #checkov:skip=CKV_AWS_144:Access logs are non-critical, single-region; replication unwarranted.
  #checkov:skip=CKV_AWS_145:CloudFront log delivery only supports SSE-S3, not CMK.
  #checkov:skip=CKV2_AWS_61:Non-critical access logs; lifecycle expiration not required for this log-delivery bucket.
  #checkov:skip=CKV2_AWS_62:Log-delivery bucket; event notifications are not applicable to raw CloudFront access logs.
  bucket = "${local.name_prefix}-cf-logs"
  # CloudFront writes access logs here as soon as the distribution serves a
  # request, so by teardown time this bucket is never empty and S3 refuses
  # DeleteBucket with BucketNotEmpty. Without force_destroy, `terraform destroy`
  # fails, `biffo teardown` aborts before removing the repo, IAM role and state
  # bucket, and the instance is left half-torn-down with no way forward from the
  # CLI (issue #280). Safe here specifically: these are ephemeral, non-critical
  # access logs — the same reasoning as the CKV2_AWS_61 skip above — and it
  # matches modules/cloud/aws/storage/main.tf, which already sets it on both of
  # its buckets. It is deliberately NOT set on the Terraform state bucket, which
  # teardown empties explicitly and separately.
  force_destroy = true
  tags          = var.tags
}

# CloudFront legacy logging requires ACLs enabled — BucketOwnerEnforced breaks it.
resource "aws_s3_bucket_ownership_controls" "cf_logs" {
  #checkov:skip=CKV2_AWS_65:CloudFront legacy log delivery requires ACLs enabled (BucketOwnerPreferred); disabling ACLs would break log delivery.
  bucket = aws_s3_bucket.cf_logs.id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_public_access_block" "cf_logs" {
  bucket                  = aws_s3_bucket.cf_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# CloudFront log delivery cannot use a CMK — SSE-S3 (AES256) only.
resource "aws_s3_bucket_server_side_encryption_configuration" "cf_logs" {
  bucket = aws_s3_bucket.cf_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "cf_logs" {
  bucket = aws_s3_bucket.cf_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_cloudfront_distribution" "portal" {
  #checkov:skip=CKV_AWS_310:Single static S3 origin; no secondary origin exists to fail over to. Failover origin block stays optional/config-driven.
  #checkov:skip=CKV_AWS_374:Public franchise marketplace must serve all geographies; geo-restriction would break the product.
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  comment             = "${local.name_prefix} portal"
  web_acl_id          = var.waf_web_acl_arn != "" ? var.waf_web_acl_arn : null

  logging_config {
    bucket          = aws_s3_bucket.cf_logs.bucket_domain_name
    include_cookies = false
    prefix          = "cloudfront/"
  }

  # Alias requires a matching ACM cert — omit both if cert is absent so CloudFront
  # falls back to its default certificate and the distribution can still be created.
  aliases = var.custom_domain != "" && var.acm_certificate_arn != "" ? [var.custom_domain] : []

  origin {
    domain_name              = var.portal_bucket_regional_domain
    origin_id                = "S3-${var.portal_bucket_name}"
    origin_access_control_id = aws_cloudfront_origin_access_control.portal.id
  }

  # Failover origin — only created when a failover domain is provided
  dynamic "origin" {
    for_each = var.failover_origin_domain != "" ? [1] : []
    content {
      domain_name = var.failover_origin_domain
      origin_id   = "failover-origin"
      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  # Sibling microservices (ADR-0007) — one origin per registered sibling,
  # reusing this same portal OAC (origin_access_control is keyed by signing
  # behavior, not per-bucket, so one OAC legitimately covers every
  # same-account S3 origin). The sibling's own bucket policy (granting this
  # distribution's ARN read access) is created by the SIBLING'S OWN
  # Terraform, not here — this module doesn't own or manage sibling buckets,
  # only routes to them.
  dynamic "origin" {
    for_each = var.sibling_origins
    content {
      domain_name              = origin.value.bucket_regional_domain
      origin_id                = "sibling-${origin.value.name}"
      origin_access_control_id = aws_cloudfront_origin_access_control.portal.id
    }
  }

  # The ROOT behavior — reserved for the user-application sibling (issue #306).
  #
  # CloudFront requires exactly one default_cache_behavior and it must name an
  # origin that exists, so until the root sibling is created and registered
  # there is nothing else to point it at: it stays on the portal bucket. That is
  # a placeholder target, not the portal serving root. The portal's landing page
  # is gone, so `/` rewrites to /index.html, S3 has no such object, and the
  # request 404s — which is the accepted outcome (issue #306, decision 3: "`/`
  # may 404 between init and the sibling's first deploy; the window is short and
  # a 404 is honest"). A 404 at `/` is fine; a distribution that fails to apply
  # because its default behavior names a non-existent origin is not.
  #
  # When the root sibling lands, this target_origin_id becomes its
  # "sibling-<name>" origin and nothing else in this file needs to change — the
  # portal already has its own explicit behaviors above.
  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "S3-${var.portal_bucket_name}"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.rewrite.arn
    }
  }

  # Two ordered_cache_behaviors per routed prefix (see
  # local.ordered_cache_behaviors) — the exact bare name and the "<name>/*"
  # wildcard — so both baseurl.com/<name> and baseurl.com/<name>/* reach that
  # prefix's own origin instead of falling through to default_cache_behavior
  # (the root). This now covers the PORTAL's own admin/login prefixes as well as
  # every sibling's; the portal is no longer the default.
  #
  # CloudFront evaluates ordered_cache_behavior blocks in list order before
  # default_cache_behavior, most-specific-first — for_each's stable per-key
  # ordering here is fine since path_pattern values are disjoint (no two
  # siblings share a name, and "admin"/"login" are reserved against siblings),
  # so evaluation order between them never matters, only that each is more
  # specific than "*".
  dynamic "ordered_cache_behavior" {
    for_each = { for b in local.ordered_cache_behaviors : b.path_pattern => b }
    content {
      path_pattern           = ordered_cache_behavior.value.path_pattern
      allowed_methods        = ["GET", "HEAD", "OPTIONS"]
      cached_methods         = ["GET", "HEAD"]
      target_origin_id       = ordered_cache_behavior.value.target_origin_id
      viewer_protocol_policy = "redirect-to-https"
      compress               = true

      forwarded_values {
        query_string = false
        cookies { forward = "none" }
      }

      min_ttl     = 0
      default_ttl = 3600
      max_ttl     = 86400

      function_association {
        event_type   = "viewer-request"
        function_arn = aws_cloudfront_function.rewrite.arn
      }
    }
  }

  # SPA routing: serve index.html for 403/404
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  restrictions {
    geo_restriction {
      # CloudFront rejects restriction_type "blacklist"/"whitelist" with an empty
      # locations list ("InvalidGeoRestrictionParameter") — "none" is the only
      # valid type when there are no countries to restrict.
      restriction_type = "none"
      locations        = []
    }
  }

  viewer_certificate {
    acm_certificate_arn            = var.acm_certificate_arn != "" ? var.acm_certificate_arn : null
    cloudfront_default_certificate = var.acm_certificate_arn == ""
    ssl_support_method             = var.acm_certificate_arn != "" ? "sni-only" : null
    minimum_protocol_version       = "TLSv1.2_2021"
  }

  tags = var.tags
}

# DNS ALIAS record — only created when a custom domain and hosted zone are provided
# allow_overwrite = true matches the cert_validation record's existing pattern; it ensures
# that if a prior partial apply left a stale record in the zone, adopting the zone via
# import doesn't block the next environment-level apply from recreating it.
resource "aws_route53_record" "portal" {
  count           = var.custom_domain != "" && var.hosted_zone_id != "" && var.acm_certificate_arn != "" ? 1 : 0
  zone_id         = var.hosted_zone_id
  name            = var.custom_domain
  type            = "A"
  allow_overwrite = true

  alias {
    name                   = aws_cloudfront_distribution.portal.domain_name
    zone_id                = aws_cloudfront_distribution.portal.hosted_zone_id
    evaluate_target_health = false
  }
}

# Bucket policy lives here (not in the storage module) so we can reference the
# specific distribution ARN — StringEquals requires an exact match, not a wildcard.
resource "aws_s3_bucket_policy" "portal" {
  bucket = var.portal_bucket_id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${var.portal_bucket_arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.portal.arn
        }
      }
    }]
  })
}
