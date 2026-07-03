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
  description = "S3 bucket for CloudFront access logs. Note: CloudFront distributions don't support native access logging in the Terraform AWS provider; this variable is reserved for future use when the provider adds support."
  type        = string
  default     = ""
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

variable "sibling_origins" {
  description = "Sibling microservices (ADR-0007) registered for path-based routing on this distribution. Each entry adds one S3 origin (reusing the portal's own OAC — origin_access_control is keyed by signing behavior, not per-bucket, so a single OAC covers every same-account S3 origin) and one ordered_cache_behavior matching \"<name>/*\", so baseurl.com/<name>/* routes to that sibling's own bucket instead of the portal's. The sibling's own bucket policy (granting this distribution's ARN read access) is the sibling's own Terraform's responsibility, not this module's — so no bucket name/ARN is needed here, only what routing requires. Populated via infra/environments/<env>/siblings.auto.tfvars.json in the consuming project (biffo sibling create's registration PR writes to that file, not to this module) — empty by default, so a project with no siblings is unaffected."
  type = list(object({
    name                   = string
    bucket_regional_domain = string
  }))
  default = []
}
