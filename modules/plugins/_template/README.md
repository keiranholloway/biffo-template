# Plugin Terraform module template

Starting point for a Biffo plugin's own Terraform module, per [ADR-0003](../../../docs/ADR/0003-plugin-system-and-marketplace.md) section 2. A plugin repo ships this (renamed to `terraform/`) alongside its `biffo.plugin.json`, `src/`, and `pyproject.toml`. `biffo plugin install <name>@<minor>` copies `terraform/` into the user's monorepo at `modules/plugins/<name>/`.

## What it wraps, and why

This module is a thin wrapper around two existing modules, not a reimplementation:

- **`modules/cloud/aws/compute`** — the plugin's Lambda function (IAM role, DLQ, log group, tracing — the same baseline every Biffo function gets).
- **`modules/cloud/aws/events`**, via the `event_bus_name` passed in from the root config — this module only adds the EventBridge rule/target/permission needed to route the plugin's declared `event_subscriptions` to its Lambda. It never creates a bus of its own.

Per **ADR-0002** ("no DB clients outside `services/api/`; microservices call the API via HTTP and react to EventBridge events"), a plugin module:

- **Never receives `db_credentials_secret_arn`.** Only the Core API's Lambda (`module.core_api` in the root config) gets that grant. A plugin that needs platform data calls the Core API over HTTPS using `BIFFO_CORE_API_URL` (wired here from `var.core_api_url`) via the plugin SDK's `BiffoAPIClient` (`packages/python-sdk/src/biffo_plugin_sdk/client.py`).
- **Is not VPC-attached by default.** `enable_vpc_access` defaults to `false` in both this module and `modules/cloud/aws/compute`, so the plugin's Lambda runs with normal Lambda internet egress — required to reach the Core API's public endpoint, especially in NAT-less environments like dev (`enable_nat_gateway = false`). Only set `enable_vpc_access = true` (and pass `vpc_id`/`private_subnet_ids`) if the plugin has a genuine ADR-0002-compliant reason to reach a VPC-only resource (e.g. ElastiCache) — never to reach the database directly. `enable_vpc_access` must be an explicit boolean, not inferred from `vpc_id` — Terraform's `count`/`for_each` can't depend on a `vpc_id` that's only known after apply.

## Variables

See `variables.tf`. The standard set every plugin module receives from the root config: `project_name`, `environment`, `plugin_name`, `event_bus_name`, `core_api_url`, `tags`. Everything else (`handler`, `event_subscriptions`, `environment_variables`, etc.) is plugin-specific.

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
}
```

See `infra/environments/dev/main.tf`'s "Plugin modules" section and `infra/environments/dev/README.md` for the full convention, including how to aggregate plugin outputs.
