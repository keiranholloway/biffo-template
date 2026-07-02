variable "project_name" {
  description = "Biffo project name — passed through unchanged from the root config."
  type        = string
}

variable "environment" {
  description = "Deployment environment (dev/staging/prod) — passed through unchanged from the root config."
  type        = string
}

variable "plugin_name" {
  description = "Plugin slug, matching biffo.plugin.json's `name` field and the services/<name>/ directory this plugin was installed into (ADR-0003 section 2). Used to namespace every resource this module creates."
  type        = string
}

variable "handler" {
  description = "Lambda handler entrypoint, e.g. `src.lambda.main.handler` per the plugin repo layout in ADR-0003 section 2."
  type        = string
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

variable "vpc_id" {
  description = <<-EOT
    VPC to attach this plugin's Lambda to. Leave empty (the default) — per
    ADR-0002, plugins never access the database directly, only the Core API
    over HTTPS and EventBridge, so VPC attachment is normally unnecessary.
    In NAT-less networking configs (e.g. dev's enable_nat_gateway = false),
    attaching to the VPC would also cut off the outbound internet access
    this Lambda needs to reach the Core API's public endpoint. Only set
    this if the plugin has a genuine, ADR-0002-compliant reason to reach a
    VPC-only resource (e.g. ElastiCache) — never to reach the database.
  EOT
  type        = string
  default     = ""
}

variable "private_subnet_ids" {
  description = "Private subnets to place ENIs in. Only used when vpc_id is set."
  type        = list(string)
  default     = []
}

variable "core_api_url" {
  description = "Core API base URL (module.api_gateway.api_endpoint from the root config). Injected as BIFFO_CORE_API_URL — the plugin SDK's BiffoAPIClient reads this env var by default (packages/python-sdk/src/biffo_plugin_sdk/client.py). This is how plugins read/write platform data per ADR-0002 — never a direct DB connection."
  type        = string
  default     = ""
}

variable "event_bus_name" {
  description = "Name of the shared EventBridge bus (module.events.event_bus_name from the root config). This module subscribes to it — it never creates its own bus, keeping every plugin's events on one platform-wide bus per ADR-0002."
  type        = string
}

variable "event_subscriptions" {
  description = "Events this plugin reacts to, mirroring biffo.plugin.json's `event_subscriptions` array (ADR-0003 section 2), e.g. [{ source = \"biffo.core\", detail_type = \"UserCreated\" }]. Leave empty if the plugin only calls the Core API and never reacts to events — no EventBridge rule is created in that case."
  type = list(object({
    source      = string
    detail_type = string
  }))
  default = []
}

variable "environment_variables" {
  description = "Additional environment variables for the plugin's Lambda, merged over BIFFO_CORE_API_URL / BIFFO_PLUGIN_NAME. Do not put database connection details here — plugins never receive them (ADR-0002)."
  type        = map(string)
  default     = {}
}

variable "sqs_kms_key_id" {
  description = "KMS key ID for the DLQ's SQS queue encryption (CKV_AWS_27). Leave empty for AWS-owned key."
  type        = string
  default     = ""
}

variable "cloudwatch_kms_key_id" {
  description = "KMS key ID for CloudWatch log group encryption (CKV_AWS_158). Leave empty for AWS-owned key."
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
