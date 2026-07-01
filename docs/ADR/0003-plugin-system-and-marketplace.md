# ADR-0003: Plugin System and Marketplace

**Status:** Proposed  
**Date:** 2026-06-30  
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

Biffo solves "system architecture" as a solved problem for solopreneurs — every scaffolded project ships with AWS infrastructure, CI/CD, governance guardrails, authentication, and a core data platform. But not every project needs the same features. Some need user management, others need analytics, document management, or CRM. Building every possible feature into the core would bloat the base deployment and slow release cycles.

The platform needs an **extension mechanism** that lets developers add functionality without modifying the core codebase. This mechanism must:

1. Allow plugins to live in **separate repositories**, maintaining independent lifecycles and versioning.
2. Provide a **consistent integration contract** so plugins work uniformly across all Biffo deployments — sharing auth, tenant scoping, and data access patterns defined in ADR-0001 and ADR-0002.
3. Surface available plugins through a **marketplace dashboard** within the Biffo admin portal, enabling users to discover, evaluate, and install plugins with a single click.
4. Support **semver versioning** with minor-version pinning (e.g., `1.2` — not `1.2.3`) so upgrades are deliberate and predictable.
5. Be **officially curated** — plugins are published and approved by the Biffo core team, though community members can submit requests for inclusion.

This ADR defines the architecture of that plugin system: the registry, the SDK, the installation flow, the API registration mechanism, and the marketplace UI.

---

## Decision

### 1. Central Registry

Plugins are catalogued in a **central JSON registry** hosted in a dedicated GitHub repository (`keiranholloway/biffo-plugins-registry`). The registry file (`plugins.json`) is the single source of truth for available plugins. Each entry contains:

```json
{
  "name": "rbac",
  "version": "1.0.0",
  "minor_version": "1.0",
  "repo": "https://github.com/keiranholloway/biffo-plugin-rbac",
  "description": "Fine-grained role-based access control layered on top of Cognito. Roles, permissions, assignments, and policy enforcement.",
  "author": "Biffo Team",
  "tags": ["auth", "security", "rbac"],
  "required_core_version": ">=2.0.0",
  "infra_modules": ["database"],
  "api_routes": ["/api/v1/rbac/roles", "/api/v1/rbac/permissions", "/api/v1/rbac/assignments"],
  "ui_components": ["nav-link", "page"],
  "status": "active"
}
```

Fields:

- `name` — unique slug, used as directory name on install
- `version` — full semver of the latest release
- `minor_version` — the pinned minor version (e.g., `"1.2"`); users install `name@minor_version`
- `repo` — clone URL of the plugin's source repository
- `description` — human-readable summary shown in the marketplace
- `author` — publisher (always "Biffo Team" for official plugins)
- `tags` — categorisation for filtering/search
- `required_core_version` — minimum Biffo core version (npm-style range)
- `infra_modules` — Terraform module categories the plugin provisions (e.g., `compute`, `storage`, `events`)
- `api_routes` — Core API routes the plugin registers (for documentation; actual registration happens via config)
- `ui_components` — portal UI elements the plugin adds
- `status` — `active` or `disabled`; disabled plugins remain in the registry but are hidden from the marketplace

When a new plugin ships or an existing one updates, a commit is pushed to the registry repo. The dashboard fetches this file to populate the marketplace.

### 2. Plugin Repository Structure

Each plugin lives in its own GitHub repository with a standardised layout:

```
biffo-plugin-rbac/
├── biffo.plugin.json          # Plugin manifest (registration metadata)
├── src/
│   ├── lambda/                # Lambda handler (FastAPI or standalone)
│   │   └── main.py
│   └── sdk/                   # Optional: plugin-specific SDK helpers
├── terraform/
│   ├── main.tf
│   ├── variables.tf
│   └── outputs.tf
├── .github/workflows/ci.yml   # Independent CI/CD pipeline
├── pyproject.toml             # Python dependencies (includes biffo-plugin-sdk)
└── README.md                  # Plugin docs
```

**Manifest (`biffo.plugin.json`):** Declares what the plugin provides and what it needs:

```json
{
  "name": "rbac",
  "version": "1.0.0",
  "tables": [
    {
      "name": "rbac_roles",
      "columns": [
        { "name": "id", "type": "UUID", "primary_key": true },
        { "name": "tenant_id", "type": "TEXT", "indexed": true },
        { "name": "name", "type": "TEXT", "unique": true },
        { "name": "description", "type": "TEXT" },
        { "name": "is_system", "type": "BOOLEAN", "default": "false" },
        { "name": "created_at", "type": "TIMESTAMP", "auto_now_add": true },
        { "name": "updated_at", "type": "TIMESTAMP", "auto_now": true }
      ]
    },
    {
      "name": "rbac_permissions",
      "columns": [
        { "name": "id", "type": "UUID", "primary_key": true },
        { "name": "tenant_id", "type": "TEXT", "indexed": true },
        { "name": "resource", "type": "TEXT" },
        { "name": "action", "type": "TEXT" },
        { "name": "effect", "type": "TEXT", "default": "\"allow\"" },
        { "name": "description", "type": "TEXT" },
        { "name": "created_at", "type": "TIMESTAMP", "auto_now_add": true }
      ]
    },
    {
      "name": "rbac_role_permissions",
      "columns": [
        { "name": "role_id", "type": "UUID", "foreign_key": "rbac_roles.id" },
        { "name": "permission_id", "type": "UUID", "foreign_key": "rbac_permissions.id" },
        { "name": "tenant_id", "type": "TEXT", "indexed": true },
        { "name": "PRIMARY KEY (role_id, permission_id)" }
      ]
    },
    {
      "name": "rbac_user_roles",
      "columns": [
        { "name": "user_id", "type": "TEXT", "foreign_key": "users.cognito_sub" },
        { "name": "role_id", "type": "UUID", "foreign_key": "rbac_roles.id" },
        { "name": "tenant_id", "type": "TEXT", "indexed": true },
        { "name": "assigned_by", "type": "TEXT", "foreign_key": "users.cognito_sub" },
        { "name": "expires_at", "type": "TIMESTAMP" },
        { "name": "assigned_at", "type": "TIMESTAMP", "auto_now_add": true },
        { "name": "PRIMARY KEY (user_id, role_id)" }
      ]
    }
  ],
  "api_routes": [
    { "method": "GET", "path": "/rbac/roles", "handler": "list_roles" },
    { "method": "POST", "path": "/rbac/roles", "handler": "create_role" },
    { "method": "GET", "path": "/rbac/roles/{role_id}", "handler": "get_role" },
    { "method": "DELETE", "path": "/rbac/roles/{role_id}", "handler": "delete_role" },
    { "method": "GET", "path": "/rbac/permissions", "handler": "list_permissions" },
    { "method": "POST", "path": "/rbac/permissions", "handler": "create_permission" },
    { "method": "GET", "path": "/rbac/assignments", "handler": "list_assignments" },
    { "method": "POST", "path": "/rbac/assignments", "handler": "assign_role" },
    { "method": "DELETE", "path": "/rbac/assignments", "handler": "unassign_role" },
    { "method": "GET", "path": "/rbac/check", "handler": "check_permission" }
  ],
  "event_subscriptions": [{ "source": "biffo.core", "detail_type": "UserCreated" }],
  "infra_modules": ["database"],
  "ui_components": [
    { "type": "nav-link", "label": "RBAC", "path": "/admin/rbac" },
    { "type": "page", "label": "Roles", "path": "/admin/rbac/roles" },
    { "type": "page", "label": "Permissions", "path": "/admin/rbac/permissions" },
    { "type": "page", "label": "Assignments", "path": "/admin/rbac/assignments" }
  ],
  "dependencies": {
    "biffo-plugin-sdk": "^1.0"
  }
}
```

### 3. Plugin SDK (`biffo-plugin-sdk`)

A Python package published to PyPI that plugins import. It provides:

- **`register_plugin(manifest: dict)`** — validates the manifest against the schema and returns a serialisable registration object. Called at plugin startup.
- **`BiffoAPIClient`** — a typed `httpx` wrapper pre-configured with the Core API URL and auth headers (injected from environment). Handles JWT injection, retry logic, and error mapping.
- **`@subscribe(detail_type: str)`** — decorator that registers an EventBridge event handler. The handler receives a parsed `BiffoEvent` with `tenant_id` extracted from the envelope.
- **`BiffoPluginBase`** — abstract base class for plugin implementations. Enforces required methods (`on_install`, `on_uninstall`, `on_upgrade`).

The SDK does **not** provide a framework or DI container — it is a thin utility layer. Plugins write plain Python; the SDK just standardises the integration points.

### 4. API Registration (Declarative Config)

Plugins declare their data models and API routes in `biffo.plugin.json`. At install time, the CLI merges this manifest into the user's repo:

- **Tables** → Alembic migration files are generated in `services/api/src/api/migrations/versions/`. The migration creates tables with `tenant_id` columns automatically (enforced by the migration generator).
- **Routes** → Route registration entries are appended to `services/api/src/api/routers/__init__.py`. The Core API discovers and mounts these routers at startup.
- **Events** → Event subscription bindings are added to the EventBridge rule configuration in the plugin's Terraform module.

This means the plugin author never touches the Core API code directly — they declare _what_ they need, and the CLI generates _how_ it connects. The Core API remains untouched between releases.

### 5. Installation Flow

When a user runs `biffo plugin install rbac@1.0`:

1. **Fetch registry** — CLI downloads `plugins.json` from the central registry repo.
2. **Resolve plugin** — Looks up `rbac` at minor version `1.0`. Validates `required_core_version` against the current Biffo version.
3. **Clone plugin repo** — Clones into `services/rbac/` within the user's monorepo.
4. **Merge Terraform** — Copies `terraform/` from the plugin into `modules/plugins/rbac/`. Adds a conditional module block to `infra/environments/<env>/main.tf` gated by an `enabled_plugins` list.
5. **Generate migrations** — Parses `biffo.plugin.json` table definitions and generates Alembic migration files in `services/api/src/api/migrations/versions/`.
6. **Register routes** — Appends route registration entries to `services/api/src/api/routers/__init__.py`.
7. **Add UI components** — Copies plugin UI pages/components into `apps/portal/src/app/` and `apps/portal/src/components/`. Next.js app router picks them up automatically at build time.
8. **Update manifest** — Records the installed plugin (name, minor version, install date) in a local `biffo.plugins.json` file in the repo root.
9. **Commit and push** — All changes are committed and pushed to the user's repo, triggering their CI pipeline which runs `terraform apply`.

The user's CI pipeline is responsible for provisioning the plugin's infrastructure. The plugin is self-contained — its own repo has its own CI/CD workflow.

### 6. Portal UI Discovery (Static Import)

After installation, the portal discovers plugin UI components through **static imports** — standard Next.js app router behaviour. Plugin pages land in `apps/portal/src/app/` as normal route segments (e.g., `apps/portal/src/app/rbac/page.tsx`). Navigation links are registered in the portal's nav component via a manifest entry.

No runtime discovery endpoint is needed. The build-time approach is simpler, type-safe, and leverages Next.js's built-in routing.

### 7. Marketplace Dashboard

The admin portal (`apps/portal/src/app/admin/`) evolves from its current stub into a plugin marketplace:

**Pages:**

- **Marketplace** (`/admin/plugins`) — Lists all active plugins from the registry with name, description, tags, version, and an "Install" button. Supports filtering by tag and searching by name/description.
- **Installed** (`/admin/plugins/installed`) — Shows plugins already installed in this deployment, with version, install date, and an "Upgrade" button (if a newer minor version is available).
- **Plugin Detail** (`/admin/plugins/[name]`) — Full description, changelog, screenshots, required permissions, and install/upgrade action.

**Data source:** The dashboard fetches `plugins.json` from the registry on mount. Installed plugins are read from the local `biffo.plugins.json` manifest.

**Actions:** Clicking "Install" triggers a CLI command (via a backend proxy endpoint) that runs the installation flow described above. The user sees progress and can review the diff before committing.

### 8. Versioning Strategy

Plugins ship semver versions. Users install at the **minor version** level:

- `biffo plugin install rbac@1.0` pins to the latest `1.0.x` patch release.
- When `1.1.0` ships, the user must explicitly run `biffo plugin install rbac@1.1` to upgrade.
- Patch updates (`1.2.0` → `1.2.1`) are pulled automatically on next install if the CLI supports a `--sync` flag.

Minor-version pinning ensures that breaking changes (new required fields, schema migrations) are deliberate and reviewed.

### 9. Upgrade and Teardown

Upgrade and teardown are the **responsibility of the application** (the user's deployment), not the platform:

- **Upgrade** — User runs `biffo plugin install <name>@<new_minor>`. The CLI pulls the new version, generates new migrations, and pushes. The user's CI runs `terraform apply` and `alembic upgrade head`.
- **Teardown (uninstall)** — User runs `biffo plugin uninstall <name>`. The CLI removes the plugin's code, Terraform modules, routes, and UI components. A cleanup migration drops the plugin's tables. The user reviews and applies.

No automatic uninstall happens. The user controls the lifecycle.

---

## Options Considered

### API Registration

#### Option A — Declarative Config _(chosen)_

Plugin declares tables and routes in `biffo.plugin.json`. CLI generates the corresponding code (migrations, route registrations) at install time.

**Pros:**

- Plugin authors don't need to understand the Core API's internals
- Consistent, auditable code generation — no hand-written route glue
- Core API stays unchanged between releases
- Easier to validate — manifest is machine-checkable against a JSON schema

**Cons:**

- Less flexibility for complex/custom route logic
- Generated code adds noise to the repo (but is deterministic and git-tracked)

#### Option B — Explicit Code

Plugin author writes the actual FastAPI routes and models in the Core API after cloning.

**Pros:**

- Full control over implementation
- No code generation layer to maintain

**Cons:**

- Plugin authors must understand Core API conventions (dependencies, auth, tenant scoping)
- Higher barrier to entry — defeats the "plug-and-play" goal
- Risk of inconsistent implementations across plugins

### Portal UI Discovery

#### Option A — Runtime Discovery

Portal fetches an endpoint from the Core API listing installed plugins and their nav entries. Dynamically renders navigation and lazy-loads pages.

**Pros:**

- No rebuild needed when installing plugins
- True dynamic extensibility

**Cons:**

- Adds an API endpoint and serialization layer
- Type safety lost — routes are strings, not compile-checked
- More moving parts (runtime discovery + lazy loading)

#### Option B — Static Import _(chosen)_

Plugin UI components are cloned into the portal's source tree at install time. Next.js app router picks them up at build time.

**Pros:**

- Leverages Next.js's built-in routing — zero additional infrastructure
- Type-safe — TypeScript catches missing props at compile time
- Simpler — no runtime discovery endpoint needed
- Faster page loads — no dynamic routing overhead

**Cons:**

- Requires a rebuild after install (acceptable — CI handles this)
- Plugin pages are part of the monorepo, not truly external

### Plugin Distribution

#### Option A — Clone into Monorepo _(chosen)_

Plugin source is cloned into `services/<name>/` within the user's monorepo. Terraform modules merged into `modules/plugins/`.

**Pros:**

- Simple — one repo, one deploy, one CI pipeline
- Plugin code is visible and editable if needed
- No cross-repo dependency complexity
- Aligns with existing `_template/` pattern

**Cons:**

- Plugin code leaves the plugin's original repo (fork drift)
- User is responsible for keeping the cloned code updated

#### Option B — Fork into User's Org

CLI forks the plugin repo into the user's GitHub org, then references it.

**Pros:**

- Clean separation — plugin stays in its own repo
- User can submit PRs back to the original plugin

**Cons:**

- Cross-repo Terraform references are fragile
- Harder to manage dependencies across repos
- Over-engineered for the common case (solopreneur with one repo)

#### Option C — Download Pre-built Artifacts

Plugin ships compiled artifacts (Lambda zip, npm package) downloaded from S3/npm.

**Pros:**

- No source code in the monorepo
- Fast install — no git clone

**Cons:**

- Black box — user can't inspect or modify plugin code
- Breaks the open-source ethos of Biffo
- Artifact signing/verification adds complexity

---

## Rationale

The chosen design prioritises **low friction for plugin authors** and **predictability for plugin consumers**. Declarative registration (Option A) means anyone can write a plugin without deep knowledge of the Core API — they just declare what they need. Static UI imports (Option B) keep the portal simple and type-safe. Cloning into the monorepo (Option A) avoids cross-repo complexity while still giving plugins independent CI/CD pipelines.

Minor-version pinning strikes the right balance between stability and freshness — users get bug fixes automatically but must consciously adopt breaking changes. Official curation maintains quality and trust without blocking community contributions (which can be submitted as PRs to the registry).

The overall architecture respects ADR-0001 (tenant isolation) and ADR-0002 (API-only data access): plugins inherit both through the SDK and the declarative registration process. No plugin can bypass the Core API or access the database directly.

---

## Consequences

### Positive

- Plugin authors can develop in isolation — each plugin is its own repo with its own CI/CD.
- Plugin consumers get a curated marketplace with one-click install.
- The Core API remains stable and uncontaminated by plugin-specific code.
- Tenant isolation and API-only data access are enforced structurally — plugins cannot bypass them.
- Minor-version pinning prevents surprise breaking changes.
- The declarative registration model lowers the barrier to entry for plugin development.
- Static UI imports mean the portal is fast, type-safe, and easy to debug.

### Negative / Trade-offs

- Cloned plugin code diverges from the original repo — keeping it updated requires manual intervention (upgrade command).
- Generated migration files and route registrations add noise to the repo (deterministic, but still tracked).
- The registry repo is a single point of failure for plugin discovery — if it goes down, the marketplace is empty (though installed plugins continue working).
- Plugin authors must follow the manifest schema strictly — deviations cause install failures.
- Rebuilding the portal after install adds latency to the install flow (mitigated by CI automation).
- Uninstall is manual — orphaned data or misconfigured rollbacks require human intervention.

### Neutral

- The `biffo-plugin-sdk` is a thin utility layer — it adds a dependency but no framework overhead.
- Plugin CI/CD pipelines are independent but must conform to Biffo's conventions (branch naming, environment structure).
- The marketplace is officially curated — community submissions are welcome but require approval.

---

## Compliance

**Registry enforcement:**

- The registry schema is validated against a JSON Schema file (`registry-schema.json`) in the registry repo.
- CI in the registry repo rejects commits that don't produce valid `plugins.json`.
- Disabled plugins are marked with `status: "disabled"` rather than removed — this preserves historical records and prevents name reuse.

**SDK enforcement:**

- The `biffo-plugin-sdk` package is versioned independently and published to PyPI.
- Plugins must declare `biffo-plugin-sdk` as a dependency in their `pyproject.toml`.
- The SDK's `register_plugin()` validates manifests against the same schema used by the registry.

**Installation enforcement:**

- The CLI validates `required_core_version` before cloning — incompatible plugins are rejected.
- Generated migrations include `tenant_id` columns automatically (enforced by the migration generator).
- Route registrations are appended to a single file (`routers/__init__.py`) with clear markers for identification.

**Security:**

- Only the Biffo core team can publish plugins to the registry.
- Plugin source code is scanned for secrets before acceptance (same as core repo).
- Plugin Terraform modules are reviewed for security compliance (Checkov, tfsec) before approval.

---

## Related Decisions

- [ADR-0001](0001-single-tenant-architecture-with-multi-tenant-seam.md) — Plugins inherit tenant isolation through the SDK and declarative registration. Every plugin-generated table includes `tenant_id`; every plugin-generated route uses `require_tenant_context()`.
- [ADR-0002](0002-api-only-data-integration-pattern.md) — Plugins access data exclusively through the Core API. No plugin ships a database client. Event subscriptions go through EventBridge, not direct DB triggers.
