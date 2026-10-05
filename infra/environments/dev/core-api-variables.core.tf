# Instance knobs for the template-owned `module "core_api"` (core-api.core.tf).
# TEMPLATE-OWNED. Set values in terraform.tfvars; defaults preserve the
# template's behaviour so an instance without overrides plans no change.

variable "core_api_memory_size" {
  description = "Core API Lambda memory (MB). Defaults to the compute module's default."
  type        = number
  default     = 512
}

variable "core_api_enable_warm_capacity" {
  description = "Attach SnapStart to the Core API live alias (see the compute module README, \"Warm capacity\")."
  type        = bool
  default     = false
}

variable "core_api_timeout" {
  description = "Core API Lambda timeout (seconds). 300 covers a DDL import batch (ADR-0005)."
  type        = number
  default     = 300
}

variable "core_api_extra_environment" {
  description = "Extra Core API environment variables from tfvars, merged after local.core_api_instance_environment (core-api.instance.tf). Plain strings only; prefer the local for anything computed."
  type        = map(string)
  default     = {}
}
