variable "org" {
  type = string
}

variable "repo_name" {
  type = string
}

variable "description" {
  type    = string
  default = ""
}

variable "environments" {
  type    = list(string)
  default = ["dev", "staging", "prod"]
}

variable "oidc_role_arn" {
  description = "AWS IAM role ARN to store as the BIFFO_OIDC_ROLE_ARN secret"
  type        = string
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "portal_bucket_dev" {
  type    = string
  default = ""
}

variable "cloudfront_distribution_dev" {
  type    = string
  default = ""
}
