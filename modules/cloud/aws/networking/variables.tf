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

variable "enable_nat_instance" {
  description = "Create a single fck-nat NAT *instance* (t4g.nano, ~$3-5/month) for private subnet egress instead of a managed NAT Gateway. This is the cheapest posture that still provides full outbound egress: it fixes the ADR-0016 in-VPC Lambda self-invoke (503) that the NAT-less posture cannot, and lets the costly interface VPC endpoints be dropped. Mutually exclusive with enable_nat_gateway (see the check block in main.tf)."
  type        = bool
  default     = false
}

variable "nat_instance_type" {
  description = "EC2 instance type for the fck-nat NAT instance. Defaults to t4g.nano (arm64 Graviton, cheapest). The AMI selected in main.tf is arm64, so a non-Graviton type here requires switching the AMI architecture filter too. Ignored when enable_nat_instance = false."
  type        = string
  default     = "t4g.nano"
}

variable "tags" {
  type    = map(string)
  default = {}
}
