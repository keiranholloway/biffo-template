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

variable "single_nat_gateway" {
  description = "Use a single NAT Gateway (cost saving for dev). False = one per AZ."
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
