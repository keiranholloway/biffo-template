variable "project_name" { type = string }
variable "environment" { type = string }

variable "lambda_function_arn" {
  description = "ARN of the Core API Lambda function to integrate"
  type        = string
}

variable "lambda_function_name" {
  description = "Name of the Core API Lambda function (for the invoke permission)"
  type        = string
}

variable "cognito_user_pool_id" { type = string }
variable "cognito_client_id" { type = string }
variable "aws_region" { type = string }

variable "cors_origins" {
  description = "List of allowed CORS origins"
  type        = list(string)
  default     = ["*"]
}

variable "tags" {
  type    = map(string)
  default = {}
}
