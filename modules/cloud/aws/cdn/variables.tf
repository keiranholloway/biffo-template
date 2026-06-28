variable "project_name" { type = string }
variable "environment" { type = string }
variable "portal_bucket_regional_domain" { type = string }
variable "portal_bucket_name" { type = string }
variable "custom_domain" { type = string, default = "" }
variable "acm_certificate_arn" {
  description = "ACM certificate ARN (must be in us-east-1 for CloudFront). Required if custom_domain is set."
  type        = string
  default     = ""
}
variable "tags" { type = map(string), default = {} }
