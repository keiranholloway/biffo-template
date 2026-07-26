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
  # The ROOT application sibling (issue #306). It is an ordinary sibling in
  # every respect except routing: its path prefix is EMPTY, so it serves "/"
  # and takes default_cache_behavior rather than a pair of ordered behaviours.
  #
  # It still carries a real, non-empty registry name — the reserved word "app"
  # — because `sibling_origins[].name` is the key everything else hangs off:
  # the origin id here, and `collectSiblings()` in the CLI's teardown. An empty
  # name would produce an origin id of "sibling-" and a sibling teardown cannot
  # find, i.e. a repo and a bucket left behind, still billing. Name and path
  # prefix are two different things; only the prefix is empty.
  root_sibling_name = "app"

  root_sibling_registered = contains([for s in var.sibling_origins : s.name], local.root_sibling_name)

  # Every sibling EXCEPT the root gets the two ordered behaviours below. The
  # root is excluded deliberately: giving it "app" and "app/*" patterns would
  # route the literal URL /app to the application that is already serving /,
  # which is a route nobody asked for and one that would shadow a future
  # sibling legitimately named "app" in some other project's mind.
  sibling_cache_behaviors = flatten([
    for s in var.sibling_origins : [
      { name = s.name, path_pattern = s.name },
      { name = s.name, path_pattern = "${s.name}/*" },
    ] if s.name != local.root_sibling_name
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
  # Which origin `/` (and everything not claimed by an explicit ordered
  # behaviour, including `/_next/*`) is served from.
  #
  # CloudFront requires EXACTLY ONE default_cache_behavior and it must name an
  # origin that exists in this distribution. There is no "absent" state and no
  # count/for_each on the block, so this cannot be expressed as a dynamic block
  # — it has to be a conditional on the target, evaluated at plan time from the
  # registry itself:
  #
  #   root sibling registered  → "sibling-app", the origin created for it by
  #                              the dynamic "origin" block below.
  #   not registered           → the portal bucket, as a PLACEHOLDER only.
  #
  # The placeholder is not the portal serving root. The portal's landing page
  # was deleted in phase 1, so `/` rewrites to /index.html, S3 has no such
  # object, and the request 404s — the accepted outcome for the window between
  # `biffo init` and the root sibling's first deploy (issue #306, decision 3:
  # the window is short and a 404 is honest). What matters is that the
  # distribution stays *valid* in that window; a default behaviour naming a
  # non-existent origin fails the apply outright and takes the whole
  # distribution — portal included — down with it.
  #
  # Note this follows the registry, not a separate flag, so there is exactly
  # one source of truth for "is there a root application?" and it is the same
  # file teardown reads.
  default_target_origin_id = (
    local.root_sibling_registered
    ? "sibling-${local.root_sibling_name}"
    : "S3-${var.portal_bucket_name}"
  )

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
# Viewer-request rewrite: self-heals the static-export "raw RSC payload"
# navigation (build-id skew → Next hard-navigates the browser to `<route>/
# index.txt`) and maps directory routes to index.html. The body lives in
# rewrite.js so it can be unit-tested; see that file's header for the full
# rationale and cli/src/lib/cdn-rewrite-function.test.ts for coverage.
resource "aws_cloudfront_function" "rewrite" {
  name    = "${local.name_prefix}-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = file("${path.module}/rewrite.js")
}

resource "aws_cloudfront_origin_access_control" "portal" {
  name                              = "${local.name_prefix}-portal-oac"
  description                       = "OAC for ${local.name_prefix} portal S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"

  # #543: deliberately NO create_before_destroy here. This OAC's `name` is fixed
  # (CloudFront OAC names must be unique per account), so create_before_destroy on
  # a forced replacement would try to create a second OAC with the SAME name
  # before destroying this one — guaranteed name collision, not a fix. It's also
  # not the #543 hazard in the first place: this OAC is referenced from the
  # STATIC origin block below (always present), not only from a dynamic block, so
  # its reference can never disappear out from under a destroy. See the comment
  # above aws_cloudfront_distribution.portal for the resource that #543 actually
  # applies to (none exists in this module today).
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

# AWS-managed policies for the authenticated plugin API behaviours (ADR-0018).
# CachingDisabled: an API response must never be cached. AllViewerExceptHostHeader:
# forward every viewer header/query/cookie EXCEPT Host (so the founder's
# Authorization JWT reaches the Lambda; a Function URL rejects a mismatched Host,
# so Host must be dropped). Referenced by well-known name rather than hardcoded id.
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# Managed data-source policies are safe by construction here — they're read-only
# AWS-owned policies, never created/destroyed by this module.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# #543 (see also #541, where this pattern previously bit): if a future change adds
# a MANAGED aws_cloudfront_origin_access_control or aws_cloudfront_origin_request_policy
# resource that is referenced ONLY from inside a dynamic "origin"/"ordered_cache_behavior"
# block below (e.g. a per-sibling or per-plugin resource, keyed by for_each/count), and
# that resource is later removed, add its address to an explicit top-level `depends_on`
# on this distribution resource. Without it, removing the resource's LAST dynamic-block
# entry makes the reference vanish from this plan entirely, so Terraform's graph has no
# edge forcing "distribution update (detach)" before "resource delete" — the delete can
# race ahead of CloudFront finishing the detach and fail with 409 OriginAccessControlInUse
# / OriginRequestPolicyInUse. (The `portal` OAC below doesn't need this: it's ALSO
# referenced from a static, always-present origin block, so the edge can never disappear.)
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

  # The shared plugin host (ADR-0021) — ONE origin (the Core API Gateway) fronting
  # every user-facing plugin. Present only when plugin_host_api_domain is set.
  dynamic "origin" {
    for_each = var.plugin_host_api_domain == "" ? [] : [var.plugin_host_api_domain]
    content {
      domain_name = origin.value
      origin_id   = "plugin-host"
      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  # The ROOT behavior — the user-application sibling's, when one is registered,
  # and the portal bucket as a placeholder when none is. See
  # local.default_target_origin_id for why this is a conditional rather than a
  # dynamic block, and what a request to `/` does in each case.
  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = local.default_target_origin_id
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

  # The shared plugin host ingress (ADR-0021), emitted FIRST — the single
  # "api/v1/plugins/*" route to the Core API Gateway that fronts every user-facing
  # plugin. Same treatment as the per-plugin API behaviours below: every method,
  # caching disabled, all viewer headers except Host forwarded so the founder's
  # Authorization JWT reaches the gateway's Cognito authorizer, and NO rewrite
  # function (that rewrites clean URLs to index.html for static export and must
  # never touch an API request). Its prefix (api/v1/plugins/*) is disjoint from the
  # "<name>/*" frontend prefixes, so ordering against them is immaterial.
  dynamic "ordered_cache_behavior" {
    for_each = var.plugin_host_api_domain == "" ? {} : { "api/v1/plugins/*" = "plugin-host" }
    content {
      path_pattern             = ordered_cache_behavior.key
      target_origin_id         = ordered_cache_behavior.value
      viewer_protocol_policy   = "redirect-to-https"
      allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
      cached_methods           = ["GET", "HEAD"]
      compress                 = true
      cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
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

  # The core's runtime identity document (#403), served from the portal bucket
  # root at /.well-known/biffo-identity.json. Every app on this origin fetches it
  # at runtime instead of baking a Cognito pool/client id into its bundle, so a
  # pool replacement no longer strands siblings pointing at a dead pool (#400).
  #
  # A SEPARATE behaviour, deliberately not folded into local.portal_cache_behaviors:
  #   - Short TTL (max 60s), the OPPOSITE of the immutable, year-long caching the
  #     hashed portal assets get — the whole point is that a replacement
  #     propagates in ~a minute, not that it is cached hard.
  #   - No rewrite function: the doc is a real file (it has a dot, so the rewrite
  #     would pass it through untouched anyway) and must never be turned into an
  #     index.html or a redirect.
  #   - Points at the portal S3 origin, where deploy-infra writes the object.
  # It must be its own behaviour so it does not fall through to
  # default_cache_behavior, which belongs to the root application sibling.
  ordered_cache_behavior {
    path_pattern           = ".well-known/*"
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
    default_ttl = 60
    max_ttl     = 60
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
