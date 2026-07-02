terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"
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

resource "aws_cloudfront_distribution" "portal" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  comment             = "${local.name_prefix} portal"
  web_acl_id          = var.waf_web_acl_arn != "" ? var.waf_web_acl_arn : null

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
