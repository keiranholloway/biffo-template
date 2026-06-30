variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "domain_prefix" {
  description = "Cognito hosted UI subdomain prefix"
  type        = string
}

variable "admin_email" {
  type = string
}

variable "admin_username" {
  type = string
}

variable "mfa_configuration" {
  type    = string
  default = "OPTIONAL"
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "mail_from_address" {
  description = "Verified SES email address to send admin-password emails from (e.g. admin-env@mail.example.com). When set, the pool switches from Cognito's default no-reply sender to this DEVELOPER sender. Leave empty to keep Cognito's default sender."
  type        = string
  default     = ""
}

variable "mail_source_arn" {
  description = "ARN of the SES identity referenced by mail_from_address. Required when mail_from_address is set. Example: arn:aws:ses:us-east-1:123456789012:identity/mail.example.com"
  type        = string
  default     = ""
}
