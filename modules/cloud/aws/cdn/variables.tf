variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "portal_bucket_regional_domain" {
  type = string
}

variable "portal_bucket_name" {
  type = string
}

variable "portal_bucket_id" {
  type = string
}

variable "portal_bucket_arn" {
  type = string
}

variable "custom_domain" {
  type    = string
  default = ""
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN (must be in us-east-1 for CloudFront). Required if custom_domain is set."
  type        = string
  default     = ""
}

variable "hosted_zone_id" {
  description = "Route 53 hosted zone ID for creating the DNS ALIAS record. Required if custom_domain is set."
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "access_logging_bucket" {
  description = "S3 bucket for CloudFront access logs. Required to satisfy CKV_AWS_86."
  type        = string
}

variable "access_logging_prefix" {
  description = "Prefix for CloudFront access log objects."
  type        = string
  default     = "cloudfront-logs/"
}

variable "waf_web_acl_arn" {
  description = "ARN of the AWS WAF Web ACL to associate with the CloudFront distribution."
  type        = string
  default     = ""
}

variable "failover_origin_domain" {
  description = "Domain name of the failover origin (e.g., backup S3 bucket or ALB). Leave empty to disable failover."
  type        = string
  default     = ""
}
