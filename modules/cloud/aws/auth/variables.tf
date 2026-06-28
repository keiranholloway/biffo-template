variable "project_name" { type = string }
variable "environment" { type = string }
variable "domain_prefix" { description = "Cognito hosted UI subdomain prefix", type = string }
variable "admin_email" { type = string }
variable "admin_username" { type = string }
variable "mfa_configuration" { type = string, default = "OPTIONAL" }
variable "tags" { type = map(string), default = {} }
