variable "project_name" {
  description = "Project name — the first segment of every resource name prefix."
  type        = string
}

variable "environment" {
  description = "Environment name (dev/staging/prod) — the second segment of the name prefix."
  type        = string
}

variable "enabled_plugins" {
  description = <<-EOT
    Names of the plugins allowed to call /api/v1/internal/* on the Core API.
    Names only — never a plugin module's role_arn output; see main.tf for why.
    Empty (the default) means no service caller is accepted at all.
  EOT
  type        = list(string)
  default     = []
}

variable "core_plugins" {
  description = <<-EOT
    First-party plugin names, always allowlisted (ADR-0014). These are core
    capability provisioned by the template-owned plugins.core.tf, so they are
    granted access to /api/v1/internal/* without the root config having to list
    them. Kept in step with plugins.core.tf's module blocks; adding a first-party
    plugin means adding it in both places.
  EOT
  type        = list(string)
  default     = ["orchestrator", "agent-runtime"]
}
