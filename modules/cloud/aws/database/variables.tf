variable "project_name" { type = string }
variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "compute_security_group_id" {
  description = "SG of the compute (Lambda) layer — only this SG gets DB access (ADR-0002)"
  type        = string
}

variable "app_db_user" {
  description = "Name of the least-privilege, non-owner Postgres role the Core API's request path connects as (#253). Created and granted by biffo:db-init, not by Terraform. Must match BIFFO_APP_ROLE_NAME on the Lambda; db-init fails loudly if they disagree."
  type        = string
  default     = "biffo_app"

  validation {
    # db_app_role.py validates the same shape before using it as a SQL
    # identifier and refuses to bootstrap anything else.
    condition     = can(regex("^[a-z_][a-z0-9_$]{0,62}$", var.app_db_user))
    error_message = "app_db_user must be a lowercase Postgres identifier: ^[a-z_][a-z0-9_$]{0,62}$."
  }
}

variable "instance_class" {
  type    = string
  default = "db.t3.micro"
}

variable "postgres_version" {
  type    = string
  default = "16"
}

variable "allocated_storage" {
  type    = number
  default = 20
}

variable "multi_az" {
  type    = bool
  default = false
}

variable "deletion_protection" {
  type    = bool
  default = false
}

variable "backup_retention_days" {
  type    = number
  default = 7
}

variable "enable_rds_proxy" {
  description = "Create an RDS Proxy in front of the database. Recommended for production (handles Lambda connection churn). Costs ~$22/month extra — disable for dev cost savings."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
