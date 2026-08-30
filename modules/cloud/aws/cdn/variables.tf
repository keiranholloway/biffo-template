variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "portal_bucket_regional_domain" {
  type = string
}

variable "portal_bucket_name" {
  type = string
}

variable "portal_bucket_id" {
  type = string
}

variable "portal_bucket_arn" {
  type = string
}

variable "custom_domain" {
  type    = string
  default = ""
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN (must be in us-east-1 for CloudFront). Required if custom_domain is set."
  type        = string
  default     = ""
}

variable "hosted_zone_id" {
  description = "Route 53 hosted zone ID for creating the DNS ALIAS record. Required if custom_domain is set."
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "access_logging_bucket" {
  description = "S3 bucket for CloudFront access logs. Note: CloudFront distributions don't support native access logging in the Terraform AWS provider; this variable is reserved for future use when the provider adds support."
  type        = string
  default     = ""
}

variable "access_logging_prefix" {
  description = "Prefix for CloudFront access log objects."
  type        = string
  default     = "cloudfront-logs/"
}

variable "waf_web_acl_arn" {
  description = "ARN of the AWS WAF Web ACL to associate with the CloudFront distribution."
  type        = string
  default     = ""
}

variable "failover_origin_domain" {
  description = "Domain name of the failover origin (e.g., backup S3 bucket or ALB). Leave empty to disable failover."
  type        = string
  default     = ""
}

variable "sibling_origins" {
  description = "Sibling microservices (ADR-0007) registered for path-based routing on this distribution. Each entry adds one S3 origin (reusing the portal's own OAC — origin_access_control is keyed by signing behavior, not per-bucket, so a single OAC covers every same-account S3 origin) and one ordered_cache_behavior matching \"<name>/*\", so baseurl.com/<name>/* routes to that sibling's own bucket instead of the portal's. The sibling's own bucket policy (granting this distribution's ARN read access) is the sibling's own Terraform's responsibility, not this module's — so no bucket name/ARN is needed here, only what routing requires. Populated via infra/environments/<env>/siblings.auto.tfvars.json in the consuming project (biffo sibling create's registration PR writes to that file, not to this module) — empty by default, so a project with no siblings is unaffected."
  type = list(object({
    name                   = string
    bucket_regional_domain = string
    # Optional human description, surfaced on the portal's Microservices tab
    # (baked into siblings.json at deploy time). Not used for routing.
    description = optional(string)
    # Optional notable routes the sibling declares in its own biffo.sibling.json
    # (e.g. [{ path = "dashboard", label = "Founder Dashboard" }]), surfaced as
    # labelled links on the portal's Microservices tab (see
    # .github/workflows/deploy-app.yml's siblings.json generation and
    # apps/portal/src/lib/siblings-api.ts). Not used for routing — CloudFront
    # already matches "<name>/*" for every non-root sibling regardless of which
    # sub-paths are declared here.
    routes = optional(list(object({
      path  = string
      label = string
    })), [])
  }))
  default = []

  # "admin" and "login" are the portal's own CloudFront path patterns (issue
  # #306). A sibling claiming either would produce a duplicate path_pattern and
  # fail the apply with an opaque duplicate-key error — reject it here, where
  # the message can say why.
  validation {
    condition     = length([for s in var.sibling_origins : s.name if contains(["admin", "login", "c"], s.name)]) == 0
    error_message = "Sibling names \"admin\", \"login\" and \"c\" are reserved for the portal's own CloudFront routes and for tracked marketing links (c/*)."
  }

  # "app" is the third reserved name, and it is reserved differently from the
  # other two: unlike "admin"/"login" it legitimately APPEARS in this list —
  # it is the root application sibling's own entry, the one main.tf's
  # default_cache_behavior follows. So it cannot be rejected outright; what
  # must be rejected is a SECOND entry claiming it.
  #
  # Uniqueness is therefore the check, and it is the right check for every
  # name, not just "app": two entries sharing a name would collapse to one
  # origin id ("sibling-<name>") and one pair of path patterns, silently
  # dropping a registered sibling from the distribution while Terraform
  # reported success.
  validation {
    condition     = length(distinct([for s in var.sibling_origins : s.name])) == length(var.sibling_origins)
    error_message = "Sibling names must be unique. Note \"app\" is reserved for the root application sibling (the one served at /, whose entry the distribution's default_cache_behavior follows) — no other sibling may claim it."
  }

  # A sibling name becomes a CloudFront origin id and, for every sibling but
  # the root, a path_pattern — so it must be a URL-safe segment. Caught here
  # rather than at apply time, where the error names neither the sibling nor
  # the file it came from.
  validation {
    condition     = length([for s in var.sibling_origins : s.name if !can(regex("^[a-z][a-z0-9-]*$", s.name))]) == 0
    error_message = "Sibling names must be lowercase kebab-case starting with a letter — they become URL path segments and CloudFront origin ids."
  }
}

variable "plugin_host_api_domain" {
  description = "Regional domain of the shared API Gateway that fronts the plugin host (ADR-0021), e.g. \"abc123.execute-api.eu-west-1.amazonaws.com\" — NO scheme, NO path. When set, this module adds one custom origin for it and one ordered_cache_behavior matching \"api/v1/plugins/*\", so baseurl.com/api/v1/plugins/<plugin>/* routes same-origin to the shared host. It forwards all viewer headers except Host (so the founder's Authorization JWT reaches the gateway's Cognito authorizer) and disables caching. ONE shared route for EVERY user-facing plugin. Empty by default (no route); typically wired to module.api_gateway's endpoint host in the root config."
  type        = string
  default     = ""
}

variable "core_api_health_domain" {
  description = <<-EOT
    Regional domain of the API Gateway fronting the Core API, e.g.
    "abc123.execute-api.eu-west-1.amazonaws.com" — NO scheme, NO path. When set,
    this module routes exactly ONE path, `api/v1/health`, to it.

    Deliberately just the health endpoint, not `api/v1/*`. Without any API
    behaviour, a request to baseurl.com/api/v1/health falls through to
    default_cache_behavior — the user-application sibling's static bucket — and
    returns that app's HTML with a 403 rather than the API's JSON. So a health
    check pointed at the public domain silently measures the wrong thing: it
    reads a 403 from a static site and reports the API as down, or reads a 200
    from an SPA shell and reports it as up. Neither answer is about the API.

    Routing the WHOLE of `api/v1/*` would remove CORS from the sibling
    frontends and is the tidier architecture, but it puts every authenticated
    endpoint behind the CDN at once and changes caching, header forwarding and
    the auth surface for all of them together. That is a separate decision;
    this variable does not make it.

    Caching is disabled (a cached health response is not a health check) and all
    viewer headers except Host are forwarded, matching plugin_host_api_domain.
    GET/HEAD/OPTIONS only — health is a read.

    Empty by default (no route). Typically wired to module.api_gateway's
    endpoint host in the root config. Safe to point at the same gateway as
    plugin_host_api_domain: CloudFront permits two origins sharing a domain
    under different origin ids, and the two path patterns are disjoint.
  EOT
  type        = string
  default     = ""
}

# Tracked marketing links (`baseurl.com/c/<token>`).
#
# Set to the same value as core_api_health_domain when both are in use — they are
# two variables rather than one so an instance can enable either route without
# the other, and so neither feature's presence is inferred from the other's.
#
# Reserved name: enabling this claims the `c/*` prefix on the distribution, which
# is why "c" is rejected as a sibling name above. Two behaviours sharing a
# path_pattern is not a silent shadow — CloudFront rejects the distribution — but
# it fails at apply with a message that names neither the sibling nor this
# feature, so it is caught at the variable instead.
variable "tracked_link_api_domain" {
  description = <<-EOT
    Regional domain of the Core API Gateway that serves tracked marketing links,
    e.g. "abc123.execute-api.eu-west-1.amazonaws.com" — NO scheme, NO path. When
    set, CloudFront routes baseurl.com/c/* to the Core API, which records the
    click and redirects to the campaign destination.

    The short branded form is the feature: these URLs are published in social
    posts, emails and ads, where a raw execute-api hostname reads as suspicious.
    It also cannot be changed later without breaking every link already in
    circulation.

    Empty by default (no behaviour, and no c/* prefix claimed).
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.tracked_link_api_domain == "" || can(regex("^[a-z0-9.-]+$", var.tracked_link_api_domain))
    error_message = "tracked_link_api_domain must be a bare domain — no scheme, no path, no trailing slash."
  }
}

# Fixes biffo-template#1529: the distribution-wide `custom_error_response`
# below (search main.tf for that name) exists to serve the portal/sibling SPA
# shell on a 403/404 from a missing static file, and CloudFront gives no way
# to scope it away from the API behaviours — so it was also rewriting every
# genuine 403/404 JSON body the API origins return into that same HTML shell.
#
# error_status_demote_lambda_arn is the QUALIFIED ARN (including a numeric
# version — Lambda@Edge requires a published version, never $LATEST) of the
# error-status-demote Lambda@Edge function — the ONLY half of the pair that is
# a Lambda@Edge with an ARN worth passing (restore is a CloudFront Function,
# created in-region, with no ARN of its own — biffo-template#1583). On the
# three API behaviours only, demote turns a real 403/404 into a 200 before
# CloudFront's error-page logic ever sees it, then restore puts the true
# status back just before the response reaches the viewer. This one variable
# gates BOTH associations (see main.tf) — they are deliberately coupled behind
# a single gate (biffo-template#1576) and must never be split. See
# error-status-demote.js and error-status-restore.js for the full mechanism.
#
# A qualified ARN, not a bare one: Lambda@Edge associations are pinned to one
# immutable version, so an instance updating this function must publish a new
# version and pass its ARN in again — CloudFront will not follow $LATEST.
#
# Lambda@Edge functions must be created in us-east-1 regardless of this
# distribution's own region (the same constraint acm_certificate_arn already
# documents), so this module does not create the function itself — it is
# created in infra/global (already us-east-1, alongside the wildcard ACM
# cert) and its qualified ARN is threaded in here, the same pattern
# acm_certificate_arn already uses.
#
# Empty by default: an instance with none of plugin_host_api_domain,
# core_api_health_domain or tracked_link_api_domain set has no API behaviour
# for this to protect, and the three `lambda_function_association` /
# `function_association` (viewer-response) blocks below are gated on this
# being non-empty, exactly as the API behaviours themselves are gated on
# their own domain variables.
variable "error_status_demote_lambda_arn" {
  description = "Qualified ARN (us-east-1, versioned) of the error-status-demote Lambda@Edge function. Gates both the demote (origin-response) and restore (viewer-response) associations, which are deliberately coupled behind this one variable (biffo-template#1576) — restore is a CloudFront Function with no ARN of its own. Output from infra/global. Empty disables the API-error-body fix — see module README."
  type        = string
  default     = ""

  # biffo-template#1574. THIS is where the demote/restore pair is made
  # impossible to half-configure, and the layer is a deliberate choice.
  #
  # The pair is coupled: demote (origin-response) turns a real 403/404 into a
  # 200 so custom_error_response cannot swallow the body, and restore
  # (viewer-response) puts the true status back. Demote WITHOUT restore ships
  # HTTP 200 on genuine API errors — strictly worse than the bug #1529 fixes,
  # because a 200 carrying an error body defeats every client that checks
  # status, including retry logic and monitoring.
  #
  # Two properties keep the half-configured state out of reach, both in this
  # module rather than in a workflow:
  #
  #   1. ONE variable gates BOTH associations, on all three API behaviours
  #      (see main.tf). There is no second switch to forget, so "demote on,
  #      restore off" is not a state this module can express. The invariant is
  #      guarded against a later refactor by
  #      cli/src/lib/cdn-error-status-coupling.test.ts, which fails if any
  #      behaviour ever gains one association without the other.
  #
  #   2. This validation, which makes a SET-BUT-WRONG value loud at plan time
  #      instead of obscure at apply time. Lambda@Edge requires a qualified
  #      ARN (trailing numeric version — never $LATEST) in us-east-1; anything
  #      else is rejected by CloudFront with an error that names neither this
  #      variable nor the reason.
  #
  # Why the module and not the workflow: #1574 exists precisely because a
  # workflow silently did not set this, so "the workflow always sets it" is
  # the assumption that failed. A workflow guard also only covers the CI path
  # — `terraform apply` run by hand, `biffo deploy` run locally, and a fork of
  # deploy-infra.yml all bypass it. More decisively, `.github/` and `modules/`
  # are template-owned but `infra/` is NOT (core-manifest.json), so an
  # instance authors its own environment stacks: the module is the only layer
  # every route to a CloudFront distribution must pass through, and the only
  # one that reaches every instance automatically via `biffo core upgrade`.
  validation {
    condition = (
      var.error_status_demote_lambda_arn == "" ||
      can(regex("^arn:aws:lambda:us-east-1:[0-9]{12}:function:[0-9A-Za-z_-]+:[0-9]+$", var.error_status_demote_lambda_arn))
    )
    error_message = "error_status_demote_lambda_arn must be empty (fix disabled) or a QUALIFIED us-east-1 Lambda@Edge ARN ending in a numeric version, e.g. arn:aws:lambda:us-east-1:123456789012:function:my-project-error-status-demote:7. An unqualified ARN, $LATEST, or another region cannot be associated with a CloudFront behaviour. Use infra/global's error_status_demote_lambda_arn output (biffo-template#1529, #1574)."
  }
}
