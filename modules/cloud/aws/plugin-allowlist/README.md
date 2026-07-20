# `plugin-allowlist`

Derives the ADR-0009 service-principal allowlist — the IAM principals the Core
API accepts on `/api/v1/internal/*` — from the list of enabled plugin names.

```hcl
module "plugin_allowlist" {
  source = "../../../modules/cloud/aws/plugin-allowlist"

  project_name    = var.project_name
  environment     = local.environment
  enabled_plugins = var.enabled_plugins
}

# on module.core_api's environment:
BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST = jsonencode(module.plugin_allowlist.arns)
```

| Input             | Type           | Default | Description                             |
| ----------------- | -------------- | ------- | --------------------------------------- |
| `project_name`    | `string`       | —       | First segment of the resource prefix    |
| `environment`     | `string`       | —       | Second segment (`dev`/`staging`/`prod`) |
| `enabled_plugins` | `list(string)` | `[]`    | Plugin **names** — never a `role_arn`   |

| Output       | Description                                       |
| ------------ | ------------------------------------------------- |
| `arns`       | Assumed-role ARN globs for the enabled plugins    |
| `account_id` | Account the roles live in (`aws_caller_identity`) |

## Why this is a module

The glob it builds — `<project>-<env>-plugin-<name>-role` — encodes a convention
owned by `modules/cloud/aws/compute` (role naming) and
`modules/plugins/_template` (function naming). Both are template-owned and ride
`biffo core upgrade`; before #266 the glob lived in the user-owned
`infra/environments/*/main.tf` and did not. A rename in either module would have
updated every instance while the allowlist stayed behind, failing closed and
breaking plugins invisibly.

`cli/src/lib/plugin-allowlist-convention.ts` is the drift guard: it reads all
three module sources and fails the build if the glob and the naming conventions
stop agreeing.

## Why names, not `role_arn`

See the header comment in `main.tf` and ADR-0009's 2026-07-19 amendment. Short
version: a name-derived glob has no dependency on any plugin module, so a broken
or cycle-forming third-party plugin can never make the Core API un-plannable.

## Fail-closed

No plugins enabled ⇒ empty list ⇒ `require_service_principal` accepts no service
caller. Do not add an "allow all" branch.
