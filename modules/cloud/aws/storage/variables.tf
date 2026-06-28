variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "cloudfront_oac_id" {
  description = "CloudFront Origin Access Control ID — if set, grants the distribution GetObject access"
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
