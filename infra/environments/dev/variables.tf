variable "project_name" {
  description = "Biffo project name — must match biffo.config.json"
  type        = string
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "admin_email" {
  description = "Email address for the initial admin Cognito user"
  type        = string
}

variable "admin_username" {
  type = string
}
