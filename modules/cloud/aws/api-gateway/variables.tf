variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "lambda_function_arn" {
  description = "ARN of the Core API Lambda function to integrate"
  type        = string
}

variable "lambda_function_name" {
  description = "Name of the Core API Lambda function (for the invoke permission)"
  type        = string
}

variable "cognito_user_pool_id" {
  type = string
}

variable "cognito_client_id" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "cors_origins" {
  description = "Origins allowed to call this API. Must be applied at the API Gateway level (not just FastAPI's CORSMiddleware) because the JWT authorizer rejects unauthenticated requests before they ever reach the Lambda, so no CORS headers would otherwise be present on 401s."
  type        = list(string)
}

variable "tags" {
  type    = map(string)
  default = {}
}
