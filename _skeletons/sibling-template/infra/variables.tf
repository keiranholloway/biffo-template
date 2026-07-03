variable "project_name" {
  description = "This sibling's name — also the path segment it's routed on (baseurl.com/<project_name>/*, ADR-0007). Must match the \"name\" this sibling was registered with in the core project's siblings.auto.tfvars.json."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*$", var.project_name))
    error_message = "project_name must be lowercase alphanumeric with hyphens, starting with a letter (it becomes a URL path segment and an AWS resource name prefix)."
  }
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

# ── Core project identity (ADR-0007) ───────────────────────────────────────
# This sibling never provisions its own Cognito pool or CloudFront
# distribution — it plugs into the core project's. These are plain
# pass-through input variables, not resources.

variable "core_cognito_user_pool_id" {
  type = string
}

variable "core_cognito_client_id" {
  type = string
}

variable "core_api_url" {
  description = "Base URL of the core project's own API — the only place this sibling may read/write core-owned data (ADR-0002)."
  type        = string
}

variable "core_portal_url" {
  description = "Origin of the core portal (e.g. https://baseurl.com) — the frontend redirects here to sign in when there is no shared session."
  type        = string
}

variable "cors_origins" {
  description = "Origins allowed to call this sibling's API. Since the frontend is served path-routed on the SAME origin as the core portal, this is normally just [core_portal_url], plus http://localhost:3000 for local dev."
  type        = list(string)
  default     = ["http://localhost:3000"]
}

# ── Two-phase CDN registration (see modules/cloud/aws/cdn's sibling_origins
# in the core project, and README.md's "Registering with the core project"
# section) ─────────────────────────────────────────────────────────────────

variable "parent_cloudfront_distribution_arn" {
  description = "ARN of the core project's CloudFront distribution. Left empty until the core project's registration PR (opened by `biffo sibling create`) has merged and redeployed — the bucket policy below is skipped while empty, since there is no distribution ARN yet to trust. Re-apply with this set once that PR merges."
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
