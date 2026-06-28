variable "project_name" { type = string }
variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "compute_security_group_id" {
  description = "SG of the compute (Lambda) layer — only this SG gets DB access (ADR-0002)"
  type        = string
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
