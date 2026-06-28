variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of AZs to span. Defaults to first 3 in the region."
  type        = list(string)
  default     = []
}

variable "enable_nat_gateway" {
  description = "Create NAT Gateway(s) for private subnet internet egress. Set false in dev to eliminate the ~$33/month base cost — Lambda runs without outbound internet; DB credentials and Cognito JWKS are injected as env vars by Terraform instead."
  type        = bool
  default     = true
}

variable "single_nat_gateway" {
  description = "Use a single NAT Gateway shared across all AZs (cost saving for dev/staging). False = one per AZ for HA. Ignored when enable_nat_gateway = false."
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
