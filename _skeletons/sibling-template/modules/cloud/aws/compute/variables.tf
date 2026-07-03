variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "function_name" {
  type = string
}

variable "handler" {
  type = string
}

variable "runtime" {
  type    = string
  default = "python3.13"
}

variable "enable_vpc_access" {
  description = "Attach this Lambda's ENIs to a VPC. Defaults to false — a sibling with no database of its own (ADR-0002/ADR-0007) gets nothing from VPC attachment, and in NAT-less networking configs it would cut off outbound internet access including calls to the core project's API."
  type        = bool
  default     = false
}

variable "vpc_id" {
  description = "VPC to attach this Lambda's ENIs to. Only used when enable_vpc_access is true."
  type        = string
  default     = ""
}

variable "private_subnet_ids" {
  description = "Private subnets to place ENIs in. Only used when enable_vpc_access is true."
  type        = list(string)
  default     = []
}

variable "memory_size" {
  type    = number
  default = 512
}

variable "timeout" {
  type    = number
  default = 30
}

variable "environment_variables" {
  type    = map(string)
  default = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "sqs_kms_key_id" {
  description = "KMS key ID for SQS queue encryption (CKV_AWS_27). Leave empty for AWS-owned key."
  type        = string
  default     = ""
}

variable "cloudwatch_kms_key_id" {
  description = "KMS key ID for CloudWatch log group encryption (CKV_AWS_158). Leave empty for AWS-owned key."
  type        = string
  default     = ""
}
