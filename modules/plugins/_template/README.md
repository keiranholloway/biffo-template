# Plugin Terraform module template

Starting point for a Biffo plugin's own Terraform module, per [ADR-0003](../../../docs/ADR/0003-plugin-system-and-marketplace.md) section 2. A plugin repo ships this (renamed to `terraform/`) alongside its `biffo.plugin.json`, `src/`, and `pyproject.toml`. `biffo plugin install <name>@<minor>` copies `terraform/` into the user's monorepo at `modules/plugins/<name>/`.

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
per [ADR-0009](../../../docs/ADR/0009-internal-service-authentication.md). There
is no bearer token to issue, store, or rotate; the credential is the plugin
Lambda's own role.

Three things must line up. Two of them this module does for you:

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
3. **Allowlist the role on the Core API.** _You must do this one._ The Core API
   independently re-checks the resolved caller ARN against
   `BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST` and **fails closed** on an empty or
   non-matching allowlist, so step 2 alone gets you a `403`. At runtime the
   caller ARN is the assumed-role session form, so allowlist a glob:

   ```
   arn:aws:sts::<account-id>:assumed-role/<project>-<env>-plugin-<name>-role/*
   ```

   That role name is this module's `role_name` output, and it is deterministic:
   `modules/cloud/aws/compute` names the role `<function_name>-role`, where
   `function_name` is `<project_name>-<environment>-plugin-<plugin_name>`.

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
out of the plugin module. Keep it that way; sourcing it from `role_arn` will
break `terraform plan` with a cycle error, not at apply time.

## Loose coupling

This module must never reference another plugin's module or resources. Each plugin is instantiated independently by the root config's `for_each`-gated `module "plugin_<name>"` block — no plugin module may assume any other plugin is installed.

## Wiring into the root config

The root config (`infra/environments/<env>/main.tf`) cannot dynamically discover plugin module directories — Terraform requires a module's `source` argument to be a static string literal, so each plugin needs its own explicit block, gated on membership in `enabled_plugins`:

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

See `infra/environments/dev/main.tf`'s "Plugin modules" section and `infra/environments/dev/README.md` for the full convention, including how to aggregate plugin outputs.
