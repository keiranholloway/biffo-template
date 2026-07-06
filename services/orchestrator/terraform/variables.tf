variable "project_name" {
  description = "Biffo project name — passed through unchanged from the root config."
  type        = string
}

variable "environment" {
  description = "Deployment environment (dev/staging/prod) — passed through unchanged from the root config."
  type        = string
}

variable "plugin_name" {
  description = "Plugin slug — matches biffo.plugin.json's `name` and the services/<name>/ directory. Namespaces every resource."
  type        = string
  default     = "orchestrator"
}

variable "handler" {
  description = "Lambda handler entrypoint."
  type        = string
  default     = "orchestrator.main.handler"
}

variable "runtime" {
  type    = string
  default = "python3.13"
}

variable "memory_size" {
  type    = number
  default = 512
}

variable "timeout" {
  type    = number
  default = 30
}

variable "core_api_url" {
  description = "Core API base URL (module.api_gateway.api_endpoint). Injected as BIFFO_CORE_API_URL; the engine signs requests to /api/v1/internal/* with SigV4 (ADR-0009)."
  type        = string
}

variable "core_api_execution_arn" {
  description = "The Core API Gateway execution ARN (aws_apigatewayv2_api.main.execution_arn, i.e. arn:aws:execute-api:<region>:<acct>:<api-id>). The engine's role is granted execute-api:Invoke scoped to this API's /api/v1/internal/* routes only."
  type        = string
}

variable "ses_identity_arn" {
  description = "ARN of the verified SES identity the engine may send from. Defaults to * (any identity in the account); scope it to a specific verified domain/address ARN in production."
  type        = string
  default     = "*"
}

variable "event_bus_name" {
  description = "Name of the shared EventBridge bus (module.events.event_bus_name). This module subscribes to it; it never creates its own bus (ADR-0002)."
  type        = string
}

variable "event_subscriptions" {
  description = "Events the engine reacts to, mirroring biffo.plugin.json's event_subscriptions. Defaults to the thin-wedge trigger (demo.requested)."
  type = list(object({
    source      = string
    detail_type = string
  }))
  default = [
    { source = "biffo.core", detail_type = "demo.requested" },
  ]
}

variable "environment_variables" {
  description = "Extra Lambda env vars merged over the defaults this module sets."
  type        = map(string)
  default     = {}
}

variable "sqs_kms_key_id" {
  type    = string
  default = ""
}

variable "cloudwatch_kms_key_id" {
  type    = string
  default = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
