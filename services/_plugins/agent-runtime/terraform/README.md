# `terraform/` — the agent runtime's infrastructure

The Lambda, IAM and EventBridge wiring for the agent runtime plugin (ADR-0014 §1). Adapted from `_skeletons/plugin-template/terraform/`, which the rest of this file documents unchanged.

**This plugin is template-owned.** It reaches instances through `biffo core upgrade` (ADR-0006 / issue #243), not `biffo plugin install`, because the agent framework is first-party platform capability rather than an optional module — see ADR-0014's amendment on why optionality, not UI, decides that. `main.tf`'s `source = "../../cloud/aws/compute"` still resolves relative to `modules/plugins/agent-runtime/` in an instance, so the module must be instantiated from there; `terraform validate` does not run against this directory in place.

What differs from the skeleton, and why:

| | Skeleton | Here | Why |
| --- | --- | --- | --- |
| `timeout` | 30s | **360s** | A model call routinely exceeds 30s. Raised from 300 so `run_timeout_seconds` could reach 300 and keep a 60s reporting margin. AWS caps an invocation at 900s (ADR-0014 §8) and a validation block enforces it. |
| `run_timeout_seconds` | — | **300s** | The runtime's own wall-clock hard stop, strictly inside `timeout` so a timed-out run can still POST its failure to Core (§5) — 60s of margin, deliberately longer than the SDK client's own 30s HTTP timeout. Raised from 240, which had no headroom under it at all: the busiest caller asked for exactly 240 (biffo-plugin-marketing#132). |
| `max_turns_ceiling` | — | **10** | Deployment ceiling a worker's `max_turns` is clamped into; a definition can only narrow it. |
| `memory_size` | 512 | **1024** | Memory buys CPU share; the runtime signs requests and parses responses around a long await. |
| `subscribe_all` | false | false | Kept false. One trigger only: `biffo.core` / `agent.run.requested`. |
| IAM | Core API | Core API **+ the configured SSM parameters** | `ssm:GetParameter` scoped to the exact ARNs of `openrouter_api_key_parameter` and `brave_search_api_key_parameter` (only the ones actually set), plus `kms:Decrypt` fenced by `kms:ViaService = ssm.<region>.amazonaws.com`. |
| `brave_search_api_key_parameter` | — | **empty** | The `web_search` tool's credential (ADR-0014 §7). Empty means the tool is not offered at all. |

**Two credentials, two different behaviours when absent.** No OpenRouter key fails every run with an explicit credential error — nothing can run without a model. No Brave key means the `web_search` tool is simply **not offered** to the model: a worker that declares it still runs, with one fewer capability, because a missing credential is an operational state rather than a broken definition (ADR-0014 §7). Setting the parameter is therefore what turns web search on in an environment, and leaving it empty is a supported way to keep it off — the grant follows the parameter, so an environment without the key also has no permission to read it.

```bash
aws ssm put-parameter --type SecureString \
  --name /myproject/dev/agent-runtime/brave-search-api-key --value "<key>"
```

**The OpenRouter key is never in this module.** Terraform takes a *parameter name*; the runtime reads the value at first use and caches it for the warm container. So the key is absent from Terraform state, absent from the Lambda's environment (where `lambda:GetFunction` would expose it), and rotatable without a deploy. Store it as a SecureString under the platform's `/<project>/<env>/<component>/<secret>` convention — the same shape as `db/credentials` and `pr-signer/github-app-key`:

```bash
aws ssm put-parameter --type SecureString \
  --name /myproject/dev/agent-runtime/openrouter-api-key --value "<key>"
```

and set `openrouter_api_key_parameter` to that name. Leave it empty and no SSM or KMS permission is created at all, and the runtime fails each run with an explicit credential error — deliberately loud, never a silent no-op.

**Why Parameter Store and not Secrets Manager** (recorded here because it looks like an inconsistency with `db/credentials` and is not one): the key is a single string fetched once per cold start, so Secrets Manager's rotation, versioning and cross-account resource policies buy nothing, while it bills roughly $0.40 per secret per month against a SecureString on the AWS-managed key being free at standard tier. The database secret is different — it is Terraform-generated and rotatable, which is what that service is for. This also matches the orchestrator's WhatsApp token, so both plugin third-party credentials are stored and fetched the same way.

**Allowlisting.** Like every plugin that calls Core's internal routes, this Lambda's role must also appear in the Core API's `BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST` (ADR-0009). Use the assumed-role glob described below — never wire the `role_arn` output into the core API module, which creates a dependency cycle (#201).

---

## Original module notes

## What it wraps, and why

This module is a thin wrapper around two existing modules, not a reimplementation:

- **`modules/cloud/aws/compute`** — the plugin's Lambda function (IAM role, DLQ, log group, tracing — the same baseline every Biffo function gets).
- **`modules/cloud/aws/events`**, via the `event_bus_name` passed in from the root config — this module only adds the EventBridge rule/target/permission needed to route the plugin's declared `event_subscriptions` to its Lambda. It never creates a bus of its own.

Per **ADR-0002** ("no DB clients outside `services/api/`; microservices call the API via HTTP and react to EventBridge events"), a plugin module:

- **Never receives `db_credentials_secret_arn`.** Only the Core API's Lambda (`module.core_api` in the root config) gets that grant. A plugin that needs platform data calls the Core API over HTTPS using `BIFFO_CORE_API_URL` (wired here from `var.core_api_url`) via the plugin SDK's Core client — see [Calling the Core API](#calling-the-core-api-adr-0009) below for how that call is authenticated.
- **Is not VPC-attached by default.** `enable_vpc_access` defaults to `false` in both this module and `modules/cloud/aws/compute`, so the plugin's Lambda runs with normal Lambda internet egress — required to reach the Core API's public endpoint, especially in NAT-less environments like dev (`enable_nat_gateway = false`). Only set `enable_vpc_access = true` (and pass `vpc_id`/`private_subnet_ids`) if the plugin has a genuine ADR-0002-compliant reason to reach a VPC-only resource (e.g. ElastiCache) — never to reach the database directly. `enable_vpc_access` must be an explicit boolean, not inferred from `vpc_id` — Terraform's `count`/`for_each` can't depend on a `vpc_id` that's only known after apply.

## Variables

See `variables.tf`. The standard set every plugin module receives from the root config: `project_name`, `environment`, `plugin_name`, `event_bus_name`, `core_api_url`, `tags`, plus `core_api_execution_arn` for any plugin that calls the Core API. Everything else (`handler`, `event_subscriptions`, `environment_variables`, etc.) is plugin-specific.

## Calling the Core API (ADR-0009)

A plugin may not touch the database (ADR-0002), so anything it needs from the
platform it fetches from the Core API. The Core API's **internal** routes
(`/api/v1/internal/*`) are authorized by **IAM SigV4**, not by a Cognito JWT —
per [ADR-0009](https://github.com/keiranholloway/biffo-template/blob/main/docs/ADR/0009-internal-service-authentication.md). There
is no bearer token to issue, store, or rotate; the credential is the plugin
Lambda's own role.

Three things must line up, and all three are wired for you — this module
does the first two, and `biffo plugin install` does the third:

1. **Sign the request.** The plugin SDK's `SignedCoreClient` does this, and
   `BiffoPluginBase` builds one by default (`create_core_client()`), so plugin
   code that just calls `self.api.post(...)` is already signing. `botocore` is
   preinstalled in the Lambda Python runtime; outside Lambda install the
   `biffo-plugin-sdk[sigv4]` extra.
2. **Grant `execute-api:Invoke`.** Set `core_api_execution_arn` (the root
   config's `module.api_gateway.execution_arn`) and this module attaches an
   inline policy to the plugin's Lambda role allowing `execute-api:Invoke` on
   `<execution_arn>/*/*/api/v1/internal/*` — that prefix only, never the whole
   API. Leave the variable empty and no grant is created.
3. **Allowlist the role on the Core API.** _Automatic since issue #201._ The
   Core API independently re-checks the resolved caller ARN against
   `BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST` and **fails closed** on an empty or
   non-matching allowlist, so step 2 alone would get you a `403`. At runtime the
   caller ARN is the assumed-role session form, so the allowlist entry is a
   glob:

   ```
   arn:aws:sts::<account-id>:assumed-role/<project>-<env>-plugin-<name>-role/*
   ```

   The template-owned `modules/cloud/aws/plugin-allowlist` module builds that
   list, mapping over the root config's `var.enabled_plugins`
   — so adding the plugin to `enabled_plugins` (which `biffo plugin install`
   does for you, via the generated `plugins.auto.tfvars.json`) is what
   allowlists it. Nothing to copy by hand, and the grant and the allowlist
   cannot drift apart.

   The role name is deterministic, which is what makes this possible:
   `modules/cloud/aws/compute` names the role `<function_name>-role`, where
   `function_name` is `<project_name>-<environment>-plugin-<plugin_name>`. It is
   also this module's `role_name` output — useful for auditing, but the root
   config deliberately does not read it (see below).

### Why the allowlist is a static string, not this module's output

Tempting as it is to write
`BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST = module.plugin_<name>.role_arn`, that
creates a Terraform **dependency cycle** (issue
[#201](https://github.com/keiranholloway/biffo-template/issues/201)):

```
core_api  ->  api_gateway  ->  plugin  ->  core_api
   (needs the plugin's role ARN)   (needs the API's execution ARN)
```

The plugin needs the API Gateway's `execution_arn` to scope its grant, and the
Core API Lambda would need the plugin's `role_arn` for its allowlist env var.
Terraform cannot order that.

The resolution — the same one the orchestrator uses — is that the arrow only
ever points **one way**: API Gateway -> plugin. The allowlist entry is written as
the _predictable_ role-name glob above, interpolated from values the root config
already knows (`project_name`, `environment`, plugin name) rather than read back
out of the plugin module.

**How close the cycle actually is.** Measured on the current module, wiring
`role_arn` does _not_ deadlock today: Terraform's dependency graph is
resource-level, not module-level, and this module's `aws_iam_role` does not
itself depend on API Gateway — only the separate `aws_iam_role_policy.core_api`
does. So a `terraform plan` with `role_arn` wired in currently builds. That is
an accident of this module's internals, not a property you can rely on: a plugin
that attached its Core API policy to the role resource itself (an inline
`inline_policy` block rather than a separate `aws_iam_role_policy`) closes the
loop immediately, and the resulting cycle error lands on whoever _installed_
that plugin, far from the code that caused it. It would also make the Core API
un-plannable whenever any installed plugin module is broken.

The static glob has no dependency on the plugin module at all, for any plugin,
which is the property worth having. Keep it that way.

## Loose coupling

This module must never reference another plugin's module or resources. Each plugin is instantiated independently by the root config's `for_each`-gated `module "plugin_<name>"` block — no plugin module may assume any other plugin is installed.

## Wiring into the root config

`biffo plugin install` generates this block for you, into a CLI-owned
`infra/environments/<env>/plugins.generated.tf` (issue #201) — you should not
need to write it by hand. It is reproduced here so you know what your module is
instantiated with.

The root config cannot dynamically discover plugin module directories —
Terraform requires a module's `source` argument to be a static string literal,
so each plugin needs its own explicit block, gated on membership in
`enabled_plugins`:

```hcl
module "plugin_<name>" {
  source   = "../../../modules/plugins/<name>"
  for_each = contains(var.enabled_plugins, "<name>") ? { "<name>" = true } : {}

  project_name   = var.project_name
  environment    = local.environment
  plugin_name    = "<name>"
  handler        = "src.lambda.main.handler"
  event_bus_name = module.events.event_bus_name
  core_api_url   = module.api_gateway.api_endpoint
  tags           = local.tags

  # Only if the plugin calls the Core API — see "Calling the Core API" below.
  core_api_execution_arn = module.api_gateway.execution_arn
}
```

The generator emits only the arguments your module actually declares a `variable` block for, so a module predating one of these inputs still wires in cleanly. See `infra/environments/dev/README.md` for the full convention.
