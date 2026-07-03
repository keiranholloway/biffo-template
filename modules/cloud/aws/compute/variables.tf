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
  description = "Attach this Lambda's ENIs to a VPC. Must be an explicit literal/boolean-derived value, not inferred from whether vpc_id is set — vpc_id is frequently only known after apply (e.g. when passed straight from a VPC created in the very same plan, such as the Core API's first-ever deploy), and Terraform's count/for_each cannot be driven by a not-yet-known value. Defaults to false — appropriate for functions that never touch the database directly (ADR-0002), since VPC attachment buys nothing for them and, in NAT-less networking configs (e.g. dev's enable_nat_gateway = false), would cut off all outbound internet access including calls to the Core API's public endpoint."
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

variable "db_credentials_secret_arn" {
  description = "ARN of the DB credentials secret in Secrets Manager — only supplied to the Core API function (ADR-0002)"
  type        = string
  default     = ""
}

variable "readable_secret_arns" {
  description = "Additional Secrets Manager secret ARNs this function may read (secretsmanager:GetSecretValue). Kept separate from db_credentials_secret_arn so a non-DB function (e.g. the PR-signer reading its GitHub App key, ADR-0008) gets least-privilege access to just its own secret without the database seam."
  type        = list(string)
  default     = []
}

variable "invoke_function_arns" {
  description = "Lambda function ARNs this function may invoke (lambda:InvokeFunction). Grants one function least-privilege permission to call another over IAM — e.g. the Core API invoking the isolated PR-signer (ADR-0008) without itself holding the signer's GitHub credential."
  type        = list(string)
  default     = []
}

variable "event_bus_name" {
  type    = string
  default = ""
}

variable "cognito_user_pool_arn" {
  description = "ARN of the Cognito user pool this function may administer (create/disable/delete users, manage group membership). Only supplied to the Core API function, which owns user management. Empty = no Cognito admin permissions granted."
  type        = string
  default     = ""
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
