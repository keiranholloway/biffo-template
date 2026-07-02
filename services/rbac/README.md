# biffo-rbac (reference plugin)

RBAC reference plugin for ADR-0003 (Plugin System and Marketplace), chunk 14
/ issue #27. Roles, permissions, role→permission grants, and user→role
assignments, layered on top of Cognito groups, with a `check_permission`
policy check.

This lives in the monorepo under `services/rbac/` — per ADR-0003 section 2's
"clone into the monorepo" decision (and the existing `services/_template/`
precedent) — rather than in a separate `biffo-plugin-rbac` repository, since
issue #26 (the plugin-repo CI/CD template that chunk would be created from)
doesn't exist yet. See "Scope and known gaps" below.

## What's here

- `biffo.plugin.json` — the manifest: `rbac_roles`, `rbac_permissions`,
  `rbac_role_permissions`, `rbac_user_roles` tables and their generic-CRUD
  `api_routes`, discoverable by the Core API's `services/*/biffo.plugin.json`
  scan (issue #18/#19) the moment this directory exists in a monorepo
  checkout.
- `src/rbac/plugin.py` — `RbacPlugin(BiffoPluginBase)`: seeds a baseline role
  set (`system.admin`, `editor`, `viewer`) on install, and subscribes to
  `biffo.core/UserCreated` to auto-assign the `viewer` role to new users.
- `src/rbac/permissions.py` — `PermissionChecker`: the `check_permission`
  logic (see "Why check_permission isn't a manifest route" below), with an
  in-memory TTL cache.
- `src/rbac/main.py` — the plugin's own Lambda entrypoint, dispatching
  EventBridge events into `RbacPlugin`'s `EventSubscriber` (mirrors
  `services/_template/src/service/main.py`).

Every table declared here is corrected against the **real, current** schema
(post-#65 ADR-0003 / `models/plugin_table.py`), not the stale example still
sitting in the original issue text (PG-enum types, an `indexed` flag,
`unique`/`foreign_key` column fields, `auto_now_add`/`auto_now`, explicit
`id`/`tenant_id`/`created_at`/`updated_at` columns, and a bare
`"PRIMARY KEY (role_id, permission_id)"` row with no type) — none of that
shape is accepted by `ColumnDefinition`/`PluginTableDefinition` today.

## Why `check_permission` isn't a manifest route

Issue #19's `RouteDefinition` (`services/api/src/api/models/plugin_route.py`)
only supports declaring `(method, path, table, operation)`, where
`operation` is one of the generic CRUD verbs (list/read/create/update/delete)
against a **single** table. `check_permission` joins three tables
(`rbac_user_roles` → `rbac_role_permissions` → `rbac_permissions`), filters
expired assignments, and resolves allow/deny precedence — none of that is a
single-table CRUD operation, and ADR-0002 forbids a plugin manifest from
shipping executable handler code the Core API would import and run. So this
plugin evaluates `check_permission` itself, in `PermissionChecker`, calling
the Core API's generic CRUD routes through `BiffoAPIClient` like any other
consumer (no direct DB access).

**This is not wired to an HTTP entrypoint in this PR.** There's currently no
Terraform (issue #25, "Terraform module provisions RDS tables conditionally"
/ conditional plugin infra inclusion) that would give this plugin's Lambda
an API Gateway route or Function URL to be reachable over HTTP at all —
`services/api/src/api/plugins.py`'s own docstring already documents that
sibling `services/*/` directories aren't bundled into a deployed Lambda
today. `PermissionChecker.check()` is fully unit-tested and ready to be
called from whatever entrypoint that infra eventually adds.

## Known gaps in the underlying infra (not fixed by this PR)

These aren't bugs introduced here — they're limitations of chunks 1/5/6/17
(#14, #18, #19, #72) as they exist today, worked around as cleanly as
possible and documented rather than silently relied upon:

- **`BiffoPluginBase.on_install`/`on_uninstall` are declared synchronous
  (issue #17), but `BiffoAPIClient` (issue #15) is entirely `async`.** A
  plugin whose install logic needs to call the Core API — this one does, to
  seed baseline roles — can't `await` from a sync method. `RbacPlugin.on_install`
  bridges this with `asyncio.run(self.seed_baseline_roles())` rather than
  redeclaring `on_install` as `async def` (which satisfies Python's ABC
  machinery at runtime but breaks pyright's static override check, and
  silently returns an unawaited coroutine to any caller — like the CLI —
  that treats `on_install()` as a plain synchronous call per its typed
  signature). The actual async logic lives in the public
  `seed_baseline_roles()` so it stays directly awaitable in tests or any
  future async caller, without going through the sync bridge. Also
  discovered but not fixed here: mirrors of both `PluginTableDefinition`
  (Core API) and `TableDefinition` (SDK)'s `_ensure_auto_columns`
  `model_validator(mode="before")` mutate their input dict in place instead
  of copying it — validating the exact same dict object twice corrupts it
  (harmless in production, since `discover_plugin_manifests()` always does
  a fresh `json.loads()` per call, but a footgun for anything — including
  this plugin's own integration tests, originally — that reuses one parsed
  manifest dict across multiple validation calls).
- **No DB-level foreign keys.** `PluginTableDefinition` has no
  `foreign_key` concept. `rbac_role_permissions.role_id` /
  `.permission_id` and `rbac_user_roles.user_id` / `.role_id` are plain
  indexed `String(36)` columns; referential integrity (a grant pointing at
  a real role/permission, an assignment pointing at a real role) is
  enforced only at the application layer, not the database.
- **No composite primary keys.** Every `PluginTableDefinition` always gets
  its own synthetic `id` primary key, unconditionally (see
  `_ensure_auto_columns` in `plugin_table.py`) — a manifest cannot declare
  `PRIMARY KEY (role_id, permission_id)` the way the issue's stale example
  did (and even if it could add `primary_key: true` to those columns, that
  would just add them to a composite key _alongside_ the already-unique
  `id`, which wouldn't actually reject a duplicate pair — the `id` alone
  guarantees row uniqueness regardless). The one-grant-per-role-permission
  and one-assignment-per-user-role invariants are enforced instead by a
  real Postgres **unique index** (`IndexDefinition(unique=True, ...)`),
  which does correctly reject duplicate pairs.
- **Declared column `default`s are not applied by the generated migration.**
  `ColumnDefinition.default` only affects the in-process SQLAlchemy model
  built by `to_sqlalchemy_model()` (used to build request/response
  handling), not the `CREATE TABLE` DDL Alembic actually emits
  (`_column_to_alembic_def` never reads `.default`). So a column declared
  with a default and then omitted from a `POST` body doesn't fall back to
  that default at the database level — it comes back `NULL` (nullable
  columns) or raises a 400 `IntegrityError` (non-nullable columns, since
  there's neither a DB default nor a Python-side one). `rbac_roles.is_system`
  and `rbac_permissions.effect` are declared `nullable: true` and NULL is
  treated as the default value (`false`/`"allow"`) by the plugin's own read
  paths, rather than relying on a default that wouldn't actually fire. This
  plugin's own code (`on_install`'s seed roles) always sets these fields
  explicitly; a future caller (e.g. an admin UI) would need to as well.
- **No query-param filtering on generic `list` routes.** `_resolve_role_id`
  (finding the `viewer` role by name) lists every role and filters
  client-side, since the generic list handler
  (`api.routing.plugin_router._make_list_handler`) has no filter support
  yet. Fine at the expected cardinality of a roles table.
- **`DELETE /assignments` in the issue's original design used a
  user_id/role_id-identified body**, not a path parameter. Issue #19's
  `RouteDefinition` requires single-row `delete` operations to address a
  row via an `{id}` path segment, so this manifest's
  `DELETE /assignments/{id}` deletes by the assignment row's own `id`
  instead.
- **The issue's route table never included a way to grant permissions to
  roles at all** (`rbac_role_permissions` had a table but no routes). This
  manifest adds `GET|POST /role-permissions` and
  `DELETE /role-permissions/{id}` — without them, `check_permission` would
  have no way to have any data to evaluate.

## `UserCreated` — wired, but not live yet

`RbacPlugin` subscribes to `biffo.core/UserCreated` and auto-assigns the
`viewer` role (see `src/rbac/plugin.py`). This is implemented using the SDK's
real `EventSubscriber`/`@subscribe` (issue #16/#17) and is unit-tested
end-to-end against a synthetic `BiffoEvent` (`tests/test_plugin.py`,
`tests/test_main.py`).

**However**, as of this PR, `services/api/src/api/routers/auth.py`'s
`get_current_user` creates a `User` row on first login but never calls
`EventPublisher.publish(...)` — verified by reading `events/base.py` and
every router in `services/api/src/api/routers/`. No code path in the Core
API publishes `UserCreated` today. This subscription is therefore dormant
in a real deployment: it will fire the moment the Core API starts
publishing that event, but this PR deliberately does not modify
`services/api/src/api/routers/auth.py` to add that publish call — that's a
Core API behavior change to a hot, already-tested path
(`/auth/me`, called on every login), outside issue #27's own stated
dependencies (chunks 1/5/6 only), and is flagged as a follow-up rather than
folded into this PR.

## Out of scope for this PR (blocked on chunks that don't exist yet)

Per issue #27's own "Dependencies" field (chunks 1, 5, 6 only — not the
epic-table's fuller list), the following acceptance criteria in the issue
are **not** addressed here, because the chunks they depend on haven't been
built:

- **"Plugin repo `biffo-plugin-rbac` created from template"** — needs #26
  (CI/CD plugin repo template). This plugin lives in the monorepo instead
  (see "What's here" above), consistent with ADR-0003 section 2 and the
  `services/_template/` precedent, until #26 exists.
- **"Portal UI pages render at `/admin/rbac/*`"** — needs #22-24 (Portal UI
  chunks), not started. `ui_components` is present in the manifest as
  informational metadata (mirroring ADR-0003's schema) for a future portal
  to consume; nothing renders it today.
- **"Terraform module provisions RDS tables conditionally"** — needs #25
  (Terraform conditional plugin inclusion), not started. This plugin ships
  no `terraform/` directory; its tables are provisioned the same way every
  other plugin's tables are today — via the Alembic migration
  `sync_plugin_migrations` generates from the manifest, applied by the
  existing `_run_db_init` path, not by dedicated plugin infra.
- **CLI install (`biffo plugin install rbac`)** — chunk 7 / #20 is being
  built concurrently by another workstream; this PR doesn't touch CLI code.

What **is** genuinely built and tested against real chunks 1/5/6: the
manifest validates against both the SDK's `PluginManifest` (chunk 1) and the
Core API's `parse_plugin_tables_from_manifest`/`parse_plugin_routes_from_manifest`
(chunk 5/6); `discover_plugin_manifests()` finds it as soon as this directory
exists in a monorepo checkout; and `build_plugin_router()` mounts its routes
and serves real CRUD requests against them (see
`services/api/tests/test_rbac_plugin_manifest_integration.py`).
