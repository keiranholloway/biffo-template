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
  description = "Lambda timeout. Headroom for the engine's in-process action retries: 3 attempts at the 10s HTTP timeout plus backoff, with room for the Core API claim/record calls either side."
  type        = number
  default     = 60
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

variable "subscribe_all" {
  description = "The engine is a generic forwarder: subscribe to every event on the bus and let the Core API match it against enabled workflow definitions. Adding a trigger is then just a definition — no Terraform change (ADR-0010). Set false only to pin the engine to an explicit `event_subscriptions` allowlist."
  type        = bool
  default     = true
}

variable "event_subscriptions" {
  description = "Explicit event allowlist, used only when `subscribe_all` is false. Mirrors biffo.plugin.json's event_subscriptions."
  type = list(object({
    source      = string
    detail_type = string
  }))
  default = []
}

variable "environment_variables" {
  description = "Extra Lambda env vars merged over the defaults this module sets."
  type        = map(string)
  default     = {}
}

variable "whatsapp_access_token_parameter" {
  description = "Name of the SSM SecureString parameter holding the Meta WhatsApp Cloud API access token (e.g. /myproject/dev/whatsapp/access-token). The engine reads it at cold start, so the token never lands in Terraform state or a Lambda env var — only its parameter name does. Empty (default) leaves the `whatsapp` action disabled."
  type        = string
  default     = ""
}

variable "whatsapp_phone_number_id_parameter" {
  description = "Name of the SSM parameter holding the Meta WhatsApp Cloud API phone-number id (the sending number). Not itself a secret, but read the same way to keep the pair together."
  type        = string
  default     = ""
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
