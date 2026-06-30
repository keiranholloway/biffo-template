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
