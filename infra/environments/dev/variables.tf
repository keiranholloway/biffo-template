variable "project_name" {
  description = "Biffo project name — must match biffo.config.json"
  type        = string
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "admin_email" {
  description = "Email address for the initial admin Cognito user"
  type        = string
}

variable "admin_username" {
  type = string
}

variable "domain" {
  description = "Root domain, e.g. biffo.io — used to look up the Route 53 hosted zone"
  type        = string
  default     = ""
}

variable "custom_domain" {
  description = "Full subdomain for this environment, e.g. dev.biffo.io"
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "Validated wildcard ACM cert ARN (us-east-1). Output from infra/global."
  type        = string
  default     = ""
}

variable "error_status_restore_lambda_arn" {
  description = "Qualified ARN (us-east-1, versioned) of the error-status-demote Lambda@Edge function (biffo-template#1529). Output from infra/global. Empty disables the API-error-body fix."
  type        = string
  default     = ""
}

variable "hosted_zone_id" {
  description = "Route 53 hosted zone ID for the domain. Output from infra/global."
  type        = string
  default     = ""
}

variable "mail_from_address" {
  description = "Optional verified SES email address used as the From sender for Cognito admin-password emails. Leave blank to use Cognito's default sender."
  type        = string
  default     = ""
}

variable "mail_source_arn" {
  description = "ARN of the SES identity for mail_from_address. Required when mail_from_address is set."
  type        = string
  default     = ""
}

variable "enabled_plugins" {
  description = <<-EOT
    Plugin names to instantiate this deploy. Each name must have a matching
    Terraform module at modules/plugins/<name>/ — `biffo plugin install <name>@<minor>`
    (ADR-0003 chunk 7) copies a plugin's terraform/ directory there. Adding a
    name here and running `terraform apply` provisions that plugin's compute
    and event infrastructure; removing a name tears it down.

    Example: ["orchestrator"]
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.enabled_plugins) == length(distinct(var.enabled_plugins))
    error_message = "enabled_plugins must not contain duplicate plugin names."
  }

  validation {
    condition     = alltrue([for name in var.enabled_plugins : can(regex("^[a-z][a-z0-9-]*$", name))])
    error_message = "enabled_plugins names must be lowercase alphanumeric with hyphens (matching a services/<name>/ and modules/plugins/<name>/ directory name)."
  }
}

variable "enable_pr_signer" {
  description = <<-EOT
    Provision the isolated PR-signer for the endpoint control plane (ADR-0008).
    When true, this creates the signer Lambda, a Secrets Manager secret for its
    GitHub App private key, and grants the Core API permission to invoke it.

    Requires a registered GitHub App with `contents:write` + `pull_requests:write`
    on this repo (see docs/guides/endpoint-control-plane-setup.md) and the App
    private key uploaded to the created secret out-of-band — the key is never
    stored in Terraform. Defaults off so the platform stands up without one.
  EOT
  type        = bool
  default     = false
}

variable "pr_signer_github_app_id" {
  description = "GitHub App ID for the PR-signer. Required when enable_pr_signer is true."
  type        = string
  default     = ""
}

variable "pr_signer_github_installation_id" {
  description = "GitHub App installation ID (the App installed on this repo). Required when enable_pr_signer is true."
  type        = string
  default     = ""
}

variable "pr_signer_repo_owner" {
  description = "Owner (org or user) of the repo the signer opens PRs against. Required when enable_pr_signer is true."
  type        = string
  default     = ""
}

variable "pr_signer_repo_name" {
  description = "Name of the repo the signer opens PRs against. Required when enable_pr_signer is true."
  type        = string
  default     = ""
}

variable "pr_signer_base_branch" {
  description = "Base branch the signer opens permission-change PRs against."
  type        = string
  default     = "main"
}

variable "sibling_origins" {
  description = <<-EOT
    Sibling microservices (ADR-0007) registered for path-based routing on
    this project's CloudFront distribution — each entry routes
    baseurl.com/<name>/* to that sibling's own S3 bucket. `biffo sibling
    create`'s registration step writes to this via
    infra/environments/<env>/siblings.auto.tfvars.json (Terraform
    auto-loads any *.auto.tfvars.json file — no HCL editing required),
    not by hand-editing terraform.tfvars.

    Example: [{ name = "billing", bucket_regional_domain = "biffo-billing-dev.s3.eu-west-1.amazonaws.com" }]
  EOT
  type = list(object({
    name                   = string
    bucket_regional_domain = string
  }))
  default = []

  validation {
    condition     = length(var.sibling_origins) == length(distinct([for s in var.sibling_origins : s.name]))
    error_message = "sibling_origins must not contain duplicate sibling names."
  }

  validation {
    condition     = alltrue([for s in var.sibling_origins : can(regex("^[a-z][a-z0-9-]*$", s.name))])
    error_message = "sibling_origins names must be lowercase alphanumeric with hyphens (matching the baseurl.com/<name>/ path segment)."
  }
}


variable "plugin_host_api_domain" {
  description = <<-EOT
    Regional domain of the Core API Gateway that fronts the shared plugin host
    (ADR-0021), e.g. "abc123.execute-api.eu-west-1.amazonaws.com" — NO scheme, NO
    path. When set, CloudFront routes baseurl.com/api/v1/plugins/* same-origin to
    the shared host (which mounts every user-facing plugin), superseding the
    per-plugin plugin_api_origins ingresses. Fed via a tfvar rather than a live
    module.api_gateway reference to avoid a cdn<->api_gateway cycle (the gateway's
    CORS already references the CloudFront domain); the value is the api_gateway
    module's api_domain output, stable across applies. Empty by default (no route).
  EOT
  type        = string
  default     = ""
}

variable "core_api_health_domain" {
  description = <<-EOT
    Regional domain of the Core API Gateway, e.g.
    "abc123.execute-api.eu-west-1.amazonaws.com" — NO scheme, NO path. When set,
    CloudFront routes exactly one path, baseurl.com/api/v1/health, to the Core
    API.

    Without it that request falls through to the root behaviour — the
    user-application sibling's static bucket — and returns that app's HTML with
    a 403. A health check pointed at the public domain then measures the static
    site, not the API.

    Deliberately only the health path, not api/v1/*. Routing everything would
    remove CORS from the sibling frontends and is arguably tidier, but it puts
    every authenticated endpoint behind the CDN at once; that is a separate
    decision.

    Fed via a tfvar rather than a live module.api_gateway reference for the same
    reason as plugin_host_api_domain: the gateway's cors_origins already
    references module.cdn.distribution_domain, so a reference the other way
    forms a cdn<->api_gateway cycle. Usually the same value as
    plugin_host_api_domain, since one gateway fronts both.
  EOT
  type        = string
  default     = ""
}

variable "tracked_link_api_domain" {
  description = <<-EOT
    Regional domain of the Core API Gateway serving tracked marketing links, e.g.
    "abc123.execute-api.eu-west-1.amazonaws.com" — NO scheme, NO path. When set,
    CloudFront routes baseurl.com/c/* to the Core API, which records the click
    and redirects to the campaign destination.

    Fed via a tfvar rather than a live module.api_gateway reference for the same
    cycle reason as plugin_host_api_domain and core_api_health_domain — the
    gateway's CORS already references module.cdn.distribution_domain. The value
    is the api_gateway module's api_domain output and is stable across applies;
    it is the same value as the other two when all are in use.

    Note this claims the c/* prefix on the distribution, so "c" is rejected as a
    sibling name while it is set.
  EOT
  type        = string
  default     = ""
}
