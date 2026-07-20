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
