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

### Refreshing an installed plugin from an out-of-tree checkout

If you develop a plugin in its own repo (say `~/code/biffo-plugin-acme-crm`)
and vendor it into an instance with `biffo plugin install --local`, there was
no way back in: `install` refuses once `services/<name>/` exists, and
`biffo plugin upgrade <name>@<minor>` has nothing to resolve until the
plugin's publish workflow has run at least once. `biffo plugin upgrade --local
<path>` is the way back in — it re-runs the same replace flow a registry
upgrade does, resolving from disk instead:

```bash
biffo plugin upgrade --local ~/code/biffo-plugin-acme-crm
```

It replaces `services/<name>/` and `modules/plugins/<name>/` with the local
checkout's current contents, re-applies the `[tool.uv.sources]` workspace
adaptation `install` originally added (a plain file copy would silently drop
it, and the next `uv run` — the migration step below — would fail outright),
regenerates the Alembic migration **only if the table set actually changed**
(a route- or code-only edit produces none), and commits. `--force` skips the
confirmation prompt, `--dry-run` prints what would happen without touching
anything — same flags as the registry path.

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

**Fields that are actually validated and used:** `name` (kebab-case), `version` (full semver), `description`, `author`, `tags`, `tables`, `api_routes`, `required_core_version`, `seed` (baseline-row declaration — see below), and — as of #1555 — a `ui_components` entry of type `nav-link`: its `label` is rendered as a link in the portal's admin nav (its `path` is validated but never trusted; see "Partial UI install" below). Anything else you may see in older examples — `event_subscriptions`, `infra_modules`, `dependencies`, and `ui_components` entries of type `page`, `dashboard-widget`, `modal` or `dialog` — is **still ignored by manifest validation and route synthesis today** (event subscriptions run in a plugin's own Lambda via the SDK, not the Core API). Don't rely on those being wired.

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

### Seeding baseline rows (biffo-template#1554)

A plugin that needs baseline data — a reference taxonomy, a default lookup row, anything a fresh install needs before the feature works at all — declares it, rather than relying on someone remembering to run a script:

```json
"seed": {
  "dir": "db/seed",
  "baseline_tables": ["your_table"]
}
```

- **`dir`** — a plugin-relative directory of `.sql` files. `biffo plugin install`/`upgrade` vendor every `*.sql` file directly under it (non-recursive, filename-sorted apply order — same convention as `biffo data import`) into the installing instance's `db/imports/_plugin-<name>/`, where that instance's existing "Apply DDL imports" deploy step (ADR-0005, see [the DDL import guide](data-import.md)) applies it on every deploy. No token, no per-tenant API call, no new deploy machinery — it reuses the mechanism `db/imports/` already was.
- **`baseline_tables`** — names of this same manifest's own `tables` that the seed guarantees populated for every tenant the deployment already knows about. Checked post-deploy (`biffo:plugin-baseline-check`, dispatched from the deploy workflow right after DDL imports): a table listed here with no rows for a known tenant fails the deploy loudly and by name, instead of the feature silently rendering nothing — the exact failure #1554 records happening for real.

**Idempotency is a contract, not a suggestion, and it is checksum-enforced.** Once a seed file has been applied anywhere, editing it makes the next deploy fail loudly (ADR-0005 §4) rather than silently re-applying or silently skipping. Write every seed file as `INSERT ... SELECT ... FROM (SELECT DISTINCT tenant_id FROM users) ... WHERE NOT EXISTS (...)` against a stable natural key, and ship a later change as a new, additively-numbered file — never an edit to one already released. `_skeletons/plugin-template/db/seed/000_default_widget.sql` is a worked example.

`biffo plugin uninstall` deliberately leaves the vendored seed directory in place, the same way it leaves your generated migration in place — dropping rows a seed created is a genuinely destructive, ambiguous operation, and ADR-0005 already declined to build a `biffo data uninstall` for the same reason.

`on_install()` is not invoked — nothing calls it, ever. See [ADR-0003 §9a](../ADR/0003-plugin-system-and-marketplace.md#9a-the-lifecycle-hooks-are-not-invoked) and the SDK's `BiffoPluginBase` docstring for why, and use `seed` above instead.

### Your declared columns are checked against the real database (biffo-template#1556)

Core builds your plugin's SQLAlchemy model from the manifest, so the manifest and the database are two documents that can disagree — and when they do, every query touching the column 500s with `UndefinedColumn` long after a green deploy. `biffo:plugin-column-check` runs in **every** deploy job (dev, staging and prod), straight after DDL imports and just before the baseline-row check above, and reads `information_schema.columns` for every table your manifest declares. You do not wire anything up; declaring a table is what opts you in.

What that means for you when it fails:

```
[prod] 1 plugin table(s) are missing column(s) their manifest declares (biffo-template#1556).

  - [prod] plugin 'marketing', table 'marketing_placements': missing column(s): channel (declared String(64))
```

Usually you added a column to `biffo.plugin.json` and did not ship the migration for it — `biffo plugin sync-migrations` (or a hand-written revision) and re-deploy. If the manifest looks right, the instance's vendored `services/<plugin>/` copy may be stale; `biffo plugin upgrade` refreshes it.

Two limits worth knowing, so you do not read more into a pass than it earned:

- It compares column **names only**. A column that exists with the wrong type, the wrong nullability, no `default`, or a missing index **passes** — comparing types across manifest → SQLAlchemy → Postgres is easy to get wrong, and a deploy guard that fails falsely is one that gets switched off. The check says so in its own output.
- It is **one-directional**. A column in the database that your manifest does not declare is fine and never fails a deploy — your tables share a database with Core and with the instance's own DDL imports.

A plugin that declares no tables passes, and that is not a warning: an all-frontend or all-compute plugin promises nothing about the schema.

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
| `biffo plugin upgrade --local <path>` | Refresh an installed plugin from a local checkout — no registry needed         |
| `biffo plugin uninstall <name>`       | Remove `services/<name>/` (and any `modules/plugins/<name>/`) and commit       |

## Terraform wiring (automatic)

If a plugin ships a `terraform/` module, `install` copies it to `modules/plugins/<name>/` **and** wires it into every `infra/environments/*/` root config (issue #201), by generating two CLI-owned files there:

| File                       | Contents                                                               |
| -------------------------- | ---------------------------------------------------------------------- |
| `plugins.generated.tf`     | one `module "plugin_<name>"` block and one output per installed plugin |
| `plugins.auto.tfvars.json` | the matching `enabled_plugins` list                                    |

Your hand-authored `main.tf` is never edited — Terraform loads every `*.tf` file in a root module directory, so the generated blocks are just as live while staying out of your file. Both files are regenerated in full from the contents of `modules/plugins/` on every install and uninstall, so re-running `install` cannot produce a duplicate module block or a duplicate `enabled_plugins` entry.

The ADR-0009 service-auth wiring comes along with it: the generated block passes `core_api_execution_arn` (granting the plugin's role `execute-api:Invoke` on `/api/v1/internal/*`), and the Core API's `BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST` follows from `module.plugin_allowlist.arns` in `main.tf` — the template-owned `modules/cloud/aws/plugin-allowlist` module, which derives a static role-name glob from `enabled_plugins`. Enabling a plugin is what allowlists it.

To disable an installed plugin without uninstalling it, override `enabled_plugins` with `-var`/`-var-file`/`TF_VAR_enabled_plugins` — all of which outrank an auto-tfvars file.

## Things the CLI does _not_ do (do these yourself)

These are deliberate — the CLI never acts on your live deployment, and never edits a file you hand-authored:

- **No `git push` and no deploy.** `install`/`upgrade`/`uninstall` commit locally only; you push and `biffo deploy` when ready.
- **Uninstall never drops tables.** Per ADR-0002 the CLI has no database client; `uninstall` removes code and commits, but the plugin's tables (and its migration file) remain. Dropping data is a manual Alembic migration. (`--keep-data` is a no-op today.)
- **`required_core_version` is not enforced** — it's printed as a warning for you to judge, since the Core API exposes no version to check against yet.
- **Partial UI install (#1555).** A `ui_components` entry of type `nav-link` renders as a link in the portal's admin nav — but only when the plugin also declares `admin_ingress`, and only to callers whose Cognito groups include its `required_group`. The link's href is always derived as `/api/v1/plugins/<name>/admin`; the manifest's own `path` string is validated but never trusted (a hand-written path can point at nothing — that was the bug #1555 fixed). `page`, `dashboard-widget`, `modal` and `dialog` entries still do nothing: declaring one validates cleanly and is otherwise ignored.
