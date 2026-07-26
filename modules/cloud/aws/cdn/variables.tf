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
    condition     = length([for s in var.sibling_origins : s.name if contains(["admin", "login"], s.name)]) == 0
    error_message = "Sibling names \"admin\" and \"login\" are reserved for the portal's own CloudFront routes."
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
