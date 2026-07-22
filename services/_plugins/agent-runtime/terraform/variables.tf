variable "project_name" {
  description = "Biffo project name — passed through unchanged from the root config."
  type        = string
}

variable "environment" {
  description = "Deployment environment (dev/staging/prod) — passed through unchanged from the root config."
  type        = string
}

variable "plugin_name" {
  description = "Plugin slug — matches biffo.plugin.json's `name` and the services/_plugins/<name>/ directory. Namespaces every resource this module creates."
  type        = string
  default     = "agent-runtime"
}

variable "handler" {
  description = "Lambda handler entrypoint — src/agent_runtime/main.py's `handler`."
  type        = string
  default     = "agent_runtime.main.handler"
}

variable "runtime" {
  type    = string
  default = "python3.13"
}

variable "memory_size" {
  description = "Lambda memory (MB). 1024 rather than the skeleton's 512: memory also buys CPU share, and the runtime spends most of an invocation awaiting a model call it must not be slow to parse, sign for, or report on. It holds no large working set — the transcript is a handful of messages."
  type        = number
  default     = 1024
}

variable "timeout" {
  description = <<-EOT
    Lambda timeout (seconds). 300, NOT the skeleton's 30: a single LLM call
    routinely runs longer than 30s, so the skeleton default would kill runs
    mid-turn and strand them in the state ADR-0014 §5 warns about.

    Two ceilings apply above this one. AWS caps a Lambda invocation at 900s
    (§8: "the platform imposes a ceiling of its own"), enforced by the
    validation below. And the runtime's own wall clock
    (var.run_timeout_seconds) must sit strictly inside this value so a run that
    exhausts its budget still has time to POST its failure to Core rather than
    being killed before it can report.
  EOT
  type        = number
  default     = 300

  validation {
    condition     = var.timeout > 0 && var.timeout <= 900
    error_message = "timeout must be between 1 and 900 seconds — AWS caps a Lambda invocation at 15 minutes (ADR-0014 section 8)."
  }
}

variable "run_timeout_seconds" {
  description = "The runtime's own per-run wall clock (ADR-0014 section 8 hard stop), injected as AGENT_RUNTIME_MAX_SECONDS. A worker definition may set a shorter timeout_seconds; it can never exceed this. Must stay below var.timeout so a timed-out run can still report its failure."
  type        = number
  default     = 240

  validation {
    condition     = var.run_timeout_seconds > 0 && var.run_timeout_seconds < var.timeout
    error_message = "run_timeout_seconds must be positive and strictly less than timeout, so a run that hits its wall clock still has time to POST its failure to Core."
  }
}

variable "max_turns_ceiling" {
  description = "Deployment-wide ceiling on a run's turn count (ADR-0014 section 8), injected as AGENT_RUNTIME_MAX_TURNS. A worker's max_turns is clamped into this, so editing a definition can never widen what the runtime will spend. M1 workers use 1 turn; the ceiling exists so an unbounded loop is impossible, not to ration ordinary use."
  type        = number
  default     = 10

  validation {
    condition     = var.max_turns_ceiling >= 1
    error_message = "max_turns_ceiling must be at least 1."
  }
}

variable "openrouter_api_key_parameter" {
  description = "Name of the SSM SecureString parameter holding the OpenRouter API key, e.g. /myproject/dev/agent-runtime/openrouter-api-key (the same /<project>/<env>/<component>/<secret> shape as db/credentials and pr-signer/github-app-key). The runtime reads it at first use; the key itself is never a Lambda environment variable and never enters Terraform state — only the parameter name does. SSM rather than Secrets Manager because this is one API key read at cold start: a SecureString on the AWS-managed key is free at standard tier, a Secrets Manager secret bills ~$0.40/month, and rotation, versioning and cross-account policies buy nothing here. It also matches the orchestrator's WhatsApp credentials, so both plugin third-party credentials live in one place. Empty (the default) grants nothing and leaves the runtime unable to call the provider — every run then fails with a clear credential error rather than silently."
  type        = string
  default     = ""
}

variable "enable_vpc_access" {
  description = <<-EOT
    Attach this plugin's Lambda to a VPC. Leave false (the default) — per
    ADR-0002, plugins never access the database directly, only the Core API
    over HTTPS and EventBridge, so VPC attachment is normally unnecessary.
    In NAT-less networking configs (e.g. dev's enable_nat_gateway = false),
    attaching to the VPC would also cut off the outbound internet access
    this Lambda needs to reach the Core API's public endpoint. Only enable
    this if the plugin has a genuine, ADR-0002-compliant reason to reach a
    VPC-only resource (e.g. ElastiCache) — never to reach the database.

    Must be an explicit boolean, not inferred from whether vpc_id is set —
    vpc_id can be only known after apply (e.g. if it were ever passed from
    a VPC created in the same plan), and Terraform's count/for_each in the
    underlying compute module cannot depend on a not-yet-known value.
  EOT
  type        = bool
  default     = false
}

variable "vpc_id" {
  description = "VPC to attach this plugin's Lambda to. Only used when enable_vpc_access is true."
  type        = string
  default     = ""
}

variable "private_subnet_ids" {
  description = "Private subnets to place ENIs in. Only used when enable_vpc_access is true."
  type        = list(string)
  default     = []
}

variable "core_api_url" {
  description = "Core API base URL (module.api_gateway.api_endpoint from the root config). Injected as BIFFO_CORE_API_URL — the plugin SDK's BiffoAPIClient reads this env var by default (packages/python-sdk/src/biffo_plugin_sdk/client.py). This is how plugins read/write platform data per ADR-0002 — never a direct DB connection."
  type        = string
  default     = ""
}

variable "core_api_execution_arn" {
  description = <<-EOT
    The Core API Gateway's execution ARN (module.api_gateway.execution_arn from
    the root config, i.e. arn:aws:execute-api:<region>:<acct>:<api-id>). When
    set, this plugin's Lambda role is granted execute-api:Invoke scoped to that
    API's /api/v1/internal/* routes only — the plugin->Core auth mechanism from
    ADR-0009 (IAM SigV4), which the plugin SDK's SignedCoreClient speaks.

    Leave empty (the default) only if the plugin never calls the Core API. It
    is not enough on its own: the Core API independently re-checks the caller
    against BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST, so the plugin's role must
    also be allowlisted there — see this module's README for the exact glob and
    why it is a static string rather than this module's role_arn output.
  EOT
  type        = string
  default     = ""
}

variable "event_bus_name" {
  description = "Name of the shared EventBridge bus (module.events.event_bus_name from the root config). This module subscribes to it — it never creates its own bus, keeping every plugin's events on one platform-wide bus per ADR-0002."
  type        = string
}

variable "event_subscriptions" {
  description = "Events this runtime reacts to — mirrors biffo.plugin.json's `event_subscriptions`. Exactly one: agent.run.requested. Invocation is EventBridge and only EventBridge (ADR-0014 section 4), and this runtime has a single trigger, so unlike the orchestrator it is not a catch-all subscriber."
  type = list(object({
    source      = string
    detail_type = string
  }))
  default = [
    {
      source      = "biffo.core"
      detail_type = "agent.run.requested"
    }
  ]
}

variable "subscribe_all" {
  description = "Left false, deliberately. The orchestrator subscribes to everything because it is a generic forwarder; this runtime executes one event type and would pay a cold start for every unrelated event on the bus if it did the same."
  type        = bool
  default     = false
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

variable "reap_schedule_expression" {
  description = <<-EOT
    How often to sweep for stale agent runs (ADR-0014 section 5, issue #402).
    An EventBridge schedule expression; empty disables the sweep entirely.

    15 minutes is deliberately far more frequent than the staleness threshold
    Core applies (agent_run_stale_after_seconds, 1800s). The two are independent
    on purpose: the schedule decides how quickly a stranded run is *noticed*,
    Core decides what counts as stranded. Sweeping often is nearly free — with
    nothing stale the route reaps nothing and emits nothing — whereas sweeping
    rarely leaves a subscriber waiting on agent.run.completed for the length of
    the gap.
  EOT
  type        = string
  default     = "rate(15 minutes)"
}

variable "tenant_id" {
  description = "Tenant the scheduled sweep runs for (ADR-0001). Single-tenant deployments leave this as \"default\"; the seam exists so a multi-tenant deployment can schedule per tenant rather than retrofitting one later."
  type        = string
  default     = "default"
}
