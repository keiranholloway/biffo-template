# Guide: Building & Installing Plugins (`biffo plugin`)

A plugin adds tables and API endpoints to a Biffo project without you writing any route code. You declare tables and routes in a `biffo.plugin.json` manifest; the Core API discovers the manifest at deploy time and synthesizes tenant-scoped, permission-gated CRUD endpoints from it, served at `/api/v1/plugins/<name>/<path>`.

For the design rationale, see [ADR-0003](../ADR/0003-plugin-system-and-marketplace.md). Enabling the endpoints a plugin declares is covered by [Exposing CRUD endpoints](generic-crud-endpoints.md).

## Where plugins live, and who owns them

There are two plugin channels, and **the directory is what declares the channel**:

|                                  | First-party                                             | Third-party / your own                                           |
| -------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| Lives at                         | `services/_plugins/<name>/`                             | `services/<name>/`                                               |
| Ownership (`core-manifest.json`) | template-owned                                          | user-owned                                                       |
| Reaches your instance via        | `biffo core upgrade` — automatic, in lockstep with core | `biffo plugin install <name>@<minor>`, or you commit it yourself |
| Safe to edit in your instance?   | **No** — an upgrade three-way-merges it                 | Yes — an upgrade never touches it                                |
| Example                          | `orchestrator`                                          | yours                                                            |

Put **your** plugin under `services/<name>/`. Putting it under
`services/_plugins/` would hand it to `biffo core upgrade` to manage, which will
merge the template's copy over yours.

The split is ownership only. Discovery, packaging, the `modules/plugins/<name>/`
Terraform module, and the plugin's Lambda name are all keyed on the plugin
**name**, so a plugin behaves identically either way at runtime. See
[ADR-0003](../ADR/0003-plugin-system-and-marketplace.md#plugin-distribution).

> **Upgrading an older instance:** if your instance has `services/orchestrator/`
> (the pre-#243 location), move it to `services/_plugins/orchestrator/`. It will
> keep working where it is — discovery matches both paths — but it stays outside
> `biffo core upgrade`'s reach until you move it, and will drift.

## Two realities today

- **Authoring and shipping your own plugin — works.** `biffo plugin create <name>` scaffolds it under `services/<name>/`; `biffo plugin install --local services/<name>` wires it up. This is the path most people want and the rest of this guide focuses on it.
- **Installing a _published_ plugin (`biffo plugin install <name>@<minor>`) — not usable yet.** The command works, but the central registry (`keiranholloway/biffo-plugins-registry`) is currently empty (`plugins: []`), so there's nothing to resolve. `install`/`upgrade`/`info` will fail with "not found in the registry" until it's populated. Use `--local` in the meantime — it takes the same validation and migration path, minus the registry lookup.

### Scaffolding a plugin

```bash
biffo plugin create acme-crm          # → services/acme-crm/, committed
biffo plugin install --local services/acme-crm
```

`create` copies `_skeletons/plugin-template/` and renames the example plugin
throughout — manifest name, Python package (`acme_crm`), class prefix
(`AcmeCrmPlugin`), distribution name, and the example table (`acme_crm_widgets`,
namespaced so two scaffolded plugins can't collide on one database). It drops
the skeleton's standalone-repo-only files (`.github/`, `registry-schema.json`)
because the host monorepo already has CI, and it always carries `terraform/` —
without it the plugin's event subscriptions would be inert everywhere (#194).

It scaffolds into the **user-owned** `services/<name>/` by default, so
`biffo core upgrade` never overwrites your plugin. `--first-party` targets the
template-owned `services/_plugins/<name>/` instead; that's only correct inside
the `biffo-template` repo itself, and the command refuses it in an instance.

`biffo plugin install --local <path>` accepts either an out-of-tree directory
(copied into `services/<name>/`) or a path already inside the checkout, in which
case it installs in place. Either way it validates the manifest, copies
`terraform/` to `modules/plugins/<name>/`, generates the Alembic migration, and
commits — the same steps the registry path performs.

## What a plugin looks like

A plugin repo (or just a directory) has a `biffo.plugin.json` at its root and, optionally, `src/` for its own non-CRUD code and `terraform/` for infra. The **manifest is the only part the Core API needs** — it's what gets bundled into the Lambda and turned into routes.

The starting point to copy is **`_skeletons/plugin-template/biffo.plugin.json`**. For a live, deployed plugin to study (event runtime, its own Lambda + Terraform), see **`services/_plugins/orchestrator`**.

### The manifest

```json
{
  "name": "notes",
  "version": "1.0.0",
  "description": "A simple notes store",
  "tables": [
    {
      "name": "notes",
      "columns": [
        { "name": "title", "type": "String(200)" },
        { "name": "body", "type": "Text", "nullable": true }
      ],
      "indexes": [{ "name": "ix_notes_title", "columns": ["title"] }],
      "permissions": {
        "list": { "allowed": true, "required_role": [] },
        "read": { "allowed": true, "required_role": [] },
        "create": { "allowed": true, "required_role": ["editor"] },
        "update": { "allowed": true, "required_role": ["editor"] },
        "delete": { "allowed": true, "required_role": ["admin"] }
      }
    }
  ],
  "api_routes": [
    { "method": "GET", "path": "/notes", "table": "notes", "operation": "list" },
    { "method": "GET", "path": "/notes/{id}", "table": "notes", "operation": "read" },
    { "method": "POST", "path": "/notes", "table": "notes", "operation": "create" },
    { "method": "PUT", "path": "/notes/{id}", "table": "notes", "operation": "update" },
    { "method": "DELETE", "path": "/notes/{id}", "table": "notes", "operation": "delete" }
  ]
}
```

**Fields that are actually validated and used:** `name` (kebab-case), `version` (full semver), `description`, `author`, `tags`, `tables`, `api_routes`, `required_core_version`. Anything else you may see in older examples — `event_subscriptions`, `ui_components`, `infra_modules`, `dependencies` — is **ignored by manifest validation and route synthesis today** (event subscriptions run in a plugin's own Lambda via the SDK, not the Core API). Don't rely on them being wired.

### Tables

- **`name`** — snake_case (`notes`, `audit_logs`).
- **`id`, `tenant_id`, `created_at`, `updated_at` are auto-injected** on every table (ADR-0001) — do **not** declare them; doing so is a hard error.
- **Columns** use SQLAlchemy **type strings**, and only these base types resolve: `String`, `Integer`, `Text`, `Boolean`, `Float`, `DateTime` — e.g. `String(255)`, `DateTime(timezone=True)`. Anything else is rejected. Per column: `nullable` (**defaults to false / NOT NULL**), `index`, `primary_key`, `default` (a SQL default _string_), `description`.
- **No foreign keys and no composite primary keys.** Reference another table with a plain `String(36)` column (enforced in your code, not the DB), and use a `unique` index over a column pair instead of a composite PK.
- **Gotcha: a column `default` is applied by the model, not the generated migration DDL.** If you need a value guaranteed at the DB level, make the column `nullable: true` and set it explicitly in your code.

### Routes

Each `api_routes` entry is `{ method, path, table, operation, description }`:

- `operation` is one of `list`/`read`/`create`/`update`/`delete`, and the method must match (list/read→GET, create→POST, update→PUT/PATCH, delete→DELETE).
- Single-row ops (`read`/`update`/`delete`) **must** include an `{id}` path param; collection ops (`list`/`create`) must **not**.
- `table` must be one of the manifest's declared tables.
- Routes are **declarations, not code** — the Core API synthesizes the handler. A route only actually serves if its table's `permissions` allow that operation (see below).

### Permissions

Each table's `permissions` block gates its routes (ADR-0004). Default-deny: an operation with no `allowed: true` returns **404** (as if it didn't exist); an allowed operation whose `required_role` doesn't match the caller's Cognito groups returns **403**. `required_role: []` means any authenticated caller. A route declared in `api_routes` but not allowed in `permissions` is 404 — so remember to set both.

## Getting your plugin live

1. **Place it at `services/<name>/`** in your project (with the manifest at `services/<name>/biffo.plugin.json`). `biffo plugin create <name>` does this for you. If your plugin lives in its own git repo, `biffo plugin install --local <path>` copies it in; `biffo plugin install <name>@<minor>` would clone it from the registry, once that's populated.
2. **Generate its migration:**

   ```bash
   biffo plugin sync-migrations <name>
   ```

   This creates a committed Alembic migration for the plugin's tables (it needs a local Python/`uv` toolchain). `biffo plugin install` runs this for you automatically; `sync-migrations` is the manual/backfill path.

3. **Commit, push, deploy:**

   ```bash
   git add services/<name> && git commit -m "feat(plugins): add <name>"
   git push
   biffo deploy <environment> --app-only
   ```

   At deploy, the manifest is bundled into the Core API Lambda and `biffo:db-init` applies the migration and builds the permission registry. Your endpoints are then live at `/api/v1/plugins/<name>/<path>`.

4. **Verify:** `biffo plugin list` shows what's in your checkout; the running API's `GET /api/v1/admin/plugins/available` (and the portal's `/admin/plugins`) shows what the deployment actually discovered.

## The `biffo plugin` commands

| Command                               | What it does                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `biffo plugin list`                   | Lists plugins in your checkout (both `services/*/` and `services/_plugins/*/`) |
| `biffo plugin create <name>`          | Scaffolds `services/<name>/` from `_skeletons/plugin-template/` and commits    |
| `biffo plugin sync-migrations [name]` | Generates missing Alembic migrations for local plugins                         |
| `biffo plugin info <name>`            | Shows a registry entry (blocked until the registry is populated)               |
| `biffo plugin install <name>@<minor>` | Clone → copy into `services/<name>/` → migration → commit (registry-gated)     |
| `biffo plugin install --local <path>` | Same, from an unpublished local directory — no registry needed                 |
| `biffo plugin upgrade <name>@<minor>` | Replace an installed plugin with a newer minor (registry-gated)                |
| `biffo plugin uninstall <name>`       | Remove `services/<name>/` (and any `modules/plugins/<name>/`) and commit       |

## Things the CLI does _not_ do (do these yourself)

These are deliberate — the CLI never acts on your live deployment or edits infra behind your back:

- **No `git push` and no deploy.** `install`/`upgrade`/`uninstall` commit locally only; you push and `biffo deploy` when ready.
- **No Terraform wiring.** If a plugin ships a `terraform/` module, the CLI copies it to `modules/plugins/<name>/` but does **not** add a module block to `infra/environments/*/main.tf` — do that by hand (tracked by issue #25).
- **Uninstall never drops tables.** Per ADR-0002 the CLI has no database client; `uninstall` removes code and commits, but the plugin's tables (and its migration file) remain. Dropping data is a manual Alembic migration. (`--keep-data` is a no-op today.)
- **`required_core_version` is not enforced** — it's printed as a warning for you to judge, since the Core API exposes no version to check against yet.
- **No UI install.** `ui_components` in a manifest are not wired into the portal.
