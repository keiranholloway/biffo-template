variable "project_name" {
  type = string
}

variable "environment" {
  type = string
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
