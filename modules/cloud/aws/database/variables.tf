variable "project_name" { type = string }
variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "compute_security_group_id" {
  description = "SG of the compute (Lambda) layer — only this SG gets DB access (ADR-0002)"
  type        = string
}

variable "app_db_user" {
  # THIS IS THE PER-ENVIRONMENT KNOB. Do not fork this module to get a
  # per-environment role name (#892).
  #
  # It has been a variable since 0.127.0 (#314, 867d58d). An instance nonetheless
  # forked the module to add `local.app_db_user = "biffo_app_${...environment}"`
  # and repointed outputs.tf at the local — three divergence declarations for what
  # one argument at the user-owned call site does:
  #
  #   module "database" {
  #     app_db_user = "biffo_app_${local.environment}"
  #   }
  #
  # The description below says what the role IS; this comment says where to set it,
  # because the first was evidently not enough to stop the fork.
  description = "Name of the least-privilege, non-owner Postgres role the Core API's request path connects as (#253). THE per-environment knob — set it at the call site rather than forking this module. Created and granted by biffo:db-init, not by Terraform. Must match BIFFO_APP_ROLE_NAME on the Lambda; db-init fails loudly if they disagree."
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

variable "skip_final_snapshot" {
  description = <<-EOT
    Skip the final snapshot when the instance is destroyed. Defaults to false —
    always snapshot — because the cost is pennies and the alternative is
    unrecoverable data loss on a destroy nobody reviewed (#387).

    It used to be `var.environment != "prod"`, so dev and staging took no
    snapshot at all. That is backwards: those are the environments where a
    replacement-forcing edit is most likely to be made and least likely to be
    read, and prod already has deletion_protection to stop it earlier.

    Set true only for a throwaway environment whose data genuinely has no value.
  EOT
  type        = bool
  default     = false
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

variable "enable_iam_database_authentication" {
  description = "Allow IAM principals to authenticate as a database role granted rds_iam. Off by default; RDS applies this without downtime. Enabling it grants nothing on its own — a no-op until a Postgres role has been granted rds_iam AND an IAM principal has been given rds-db:connect on that specific dbuser: resource, so do not read the switch alone as broken or as sufficient."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
