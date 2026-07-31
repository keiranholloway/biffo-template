# First-party plugin provisioning — TEMPLATE-OWNED (ADR-0014, closes #406).
#
# This file is a carve-out inside the otherwise user-owned infra/environments/
# tree (see core-manifest.json), the same pattern as apps/portal/ inside apps/.
# It rides `biffo core upgrade`, so every instance gets the agentic plugins wired
# identically and stays in parity — including any first-party plugin added to the
# template later.
#
# ## Why this is template-owned, and why it used to drift
#
# services/_plugins/<name>/ (source) and its terraform/ already ship to every
# instance. What never did was the *instantiation* — the module blocks below.
# `biffo plugin install` generates those for THIRD-PARTY plugins (into the
# user-owned plugins.generated.tf), but first-party plugins had no equivalent, so
# they were hand-wired per instance and drifted (#406): tabsii had them, a fresh
# instance had nothing, and its agentic features were dead while every deploy
# still paid to look for the missing Lambdas.
#
# ADR-0014 settles the ownership: agentic capability is core, not an optional
# add-on, so its infrastructure belongs to the template. Adding a first-party
# plugin now means one block here plus its name in the plugin-allowlist module's
# core_plugins default (modules/cloud/aws/plugin-allowlist) — both template-owned,
# changed together, distributed together.
#
# ## What it depends on
#
# Only the guaranteed, template-seeded shape of an instance's dev env:
# var.project_name, local.environment, local.tags, and the module.events /
# module.api_gateway outputs. It deliberately does NOT reference the optional
# plugin-credential variables (var.openrouter_api_key_parameter, var.whatsapp_*):
# those are absent from older instances' user-owned variables.tf, so referencing
# them would break the upgrade. Credentials are passed by SSM-path *convention*
# instead (below), which needs no per-instance variable.

variable "enable_core_plugins" {
  description = <<-EOT
    Provision the first-party agentic plugins (orchestrator, agent-runtime).
    Defaults true: agentic capability is core (ADR-0014), so it is on everywhere
    unless a deployment deliberately opts out. Set false only for an instance
    that genuinely runs no agents — the escape hatch, not the norm.
  EOT
  type        = bool
  default     = true
}

# Branding for the transactional emails the orchestration engine sends.
#
# `orchestrator.email_branding` has read this config surface since #378, but
# nothing ever supplied it: no instance passed these env vars, so every Biffo
# instance's candidate-facing email went out headed with the module's
# brand-neutral fallback, "Biffo". That fallback is doing its job — it keeps an
# unconfigured instance rendering a coherent email — but it was the ONLY value
# reachable, which made it a default nobody chose rather than a default anybody
# could override.
#
# Declared here, inline, rather than in the instance's variables.tf: this file is
# template-owned and rides `biffo core upgrade`, so a variable it references must
# be one it also declares (see this file's header — referencing an instance's
# user-owned variables is what breaks the upgrade for older instances). An
# instance supplies the values from its own tfvars; supplying nothing keeps
# today's behaviour exactly.
variable "email_branding" {
  description = <<-EOT
    Branding applied to transactional emails sent by the orchestration engine.
    Every attribute is optional; an omitted one falls back to the brand-neutral
    default in orchestrator/email_branding.py. `logo_url` must be an absolute,
    publicly-reachable URL — SES does not host attachments, so the recipient's
    client fetches it directly. `footer_links` is a comma-separated list of
    `Label|URL` pairs.
  EOT
  type = object({
    company_name     = optional(string, "")
    logo_url         = optional(string, "")
    logo_alt         = optional(string, "")
    primary_color    = optional(string, "")
    background_color = optional(string, "")
    footer_text      = optional(string, "")
    footer_links     = optional(string, "")
    from_name        = optional(string, "")
    subject_prefix   = optional(string, "")
  })
  default = {}

  # A colour goes straight into the inline CSS of every email. A typo'd one is
  # invisible in a plan and shows up as an unstyled email in a real inbox, so
  # reject it here rather than at the recipient.
  validation {
    condition = alltrue([
      for c in [var.email_branding.primary_color, var.email_branding.background_color] :
      c == "" || can(regex("^#[0-9A-Fa-f]{6}$", c))
    ])
    error_message = "primary_color and background_color must be 6-digit hex like \"#1f2933\", or empty to use the default."
  }
}

locals {
  # Empty attributes are dropped rather than passed as empty env vars, so an
  # unset field falls through to the Python default by absence. That matters for
  # the colours: `from_env` reads them with `or defaults.x`, but the string
  # fields use `.get(key, default)`, where a present-but-empty value would win
  # and blank the field instead of falling back.
  email_branding_env = {
    for k, v in {
      EMAIL_BRANDING_COMPANY_NAME     = var.email_branding.company_name
      EMAIL_BRANDING_LOGO_URL         = var.email_branding.logo_url
      EMAIL_BRANDING_LOGO_ALT         = var.email_branding.logo_alt
      EMAIL_BRANDING_PRIMARY_COLOR    = var.email_branding.primary_color
      EMAIL_BRANDING_BACKGROUND_COLOR = var.email_branding.background_color
      EMAIL_BRANDING_FOOTER_TEXT      = var.email_branding.footer_text
      EMAIL_BRANDING_FOOTER_LINKS     = var.email_branding.footer_links
      EMAIL_BRANDING_FROM_NAME        = var.email_branding.from_name
      EMAIL_BRANDING_SUBJECT_PREFIX   = var.email_branding.subject_prefix
    } : k => v if v != ""
  }
}

# The orchestration engine: reacts to every event, matches enabled workflow
# definitions via the Core internal API, dispatches their actions. No third-party
# credential is wired by default — the WhatsApp action is opt-in per instance and
# stays disabled (empty parameter names) until configured.
module "plugin_orchestrator" {
  source   = "../../../services/_plugins/orchestrator/terraform"
  for_each = var.enable_core_plugins ? { orchestrator = true } : {}

  project_name           = var.project_name
  environment            = local.environment
  plugin_name            = "orchestrator"
  handler                = "orchestrator.main.handler"
  event_bus_name         = module.events.event_bus_name
  core_api_url           = module.api_gateway.api_endpoint
  core_api_execution_arn = module.api_gateway.execution_arn

  environment_variables = local.email_branding_env

  tags = local.tags
}

# The agent runtime: executes an agent run (LLM loop + tools) on an
# agent.run.requested event, reports the result to Core. The OpenRouter key is
# required for any agent to run, so it is wired by SSM-path convention here — the
# runtime reads the key from this SecureString at cold start; the key itself
# never enters Terraform state or a Lambda env var (ADR-0014 security model).
#
# Create it before agents can run (once per environment):
#
#   aws ssm put-parameter --type SecureString \
#     --name /<project_name>/<environment>/agent-runtime/openrouter-api-key \
#     --value <key>
#
# Until it exists, the Lambda deploys fine and runs fail with a clear credential
# error rather than silently. The web_search tool's Brave key is left off by
# default (empty), so a worker that declares it simply runs with one fewer
# capability until an instance opts in.
module "plugin_agent_runtime" {
  source   = "../../../services/_plugins/agent-runtime/terraform"
  for_each = var.enable_core_plugins ? { "agent-runtime" = true } : {}

  project_name           = var.project_name
  environment            = local.environment
  plugin_name            = "agent-runtime"
  handler                = "agent_runtime.main.handler"
  event_bus_name         = module.events.event_bus_name
  core_api_url           = module.api_gateway.api_endpoint
  core_api_execution_arn = module.api_gateway.execution_arn

  openrouter_api_key_parameter = "/${var.project_name}/${local.environment}/agent-runtime/openrouter-api-key"

  tags = local.tags
}

# Core -> agent-runtime synchronous invoke grant (ADR-0016).
#
# The prompt-assistant endpoint (POST /api/v1/admin/agent-chat) fronts a chat
# turn through Core's existing API Gateway + Cognito, then synchronously invokes
# the agent-runtime Lambda (RequestResponse) for the LLM turn. So the Core API's
# execution role needs lambda:InvokeFunction on that function.
#
# This lives HERE, template-owned, rather than as an argument to module.core_api
# in the user-owned main.tf, so it rides `biffo core upgrade` — the same reason
# the plugin module blocks above are carved out. When it lived in main.tf, a
# freshly-init'd or upgraded instance got a Core role with no invoke permission
# (and, before the convention-derivation in services/api, no function name) and a
# dead assistant returning 503. Gated on the same var.enable_core_plugins as the
# plugin itself, so it appears only when the runtime it targets does.
#
# This is a LEAF resource: it depends on both module.core_api (role) and
# module.plugin_agent_runtime (target ARN), but neither of those depends on it,
# so it does NOT create the core_api -> api_gateway -> plugin -> core_api cycle
# that issue #201 warns about (which comes from feeding a plugin's output back
# INTO module.core_api's inputs). The function name Core needs is derived by
# convention in services/api (config.py), not from a module output, for the same
# reason. Verified with `terraform validate`.
resource "aws_iam_role_policy" "core_api_invoke_agent_runtime" {
  for_each = var.enable_core_plugins ? { "agent-runtime" = true } : {}

  name = "invoke-agent-runtime"
  role = module.core_api.role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InvokeAgentRuntime"
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = module.plugin_agent_runtime[each.key].function_arn
      }
    ]
  })
}
