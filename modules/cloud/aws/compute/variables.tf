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

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
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

variable "event_bus_name" {
  type    = string
  default = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
