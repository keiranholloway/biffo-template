# ADR-0004: Generic CRUD Layer and Declarative Table Permissions

**Status:** Proposed
**Date:** 2026-07-01
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

Today, every Core API endpoint is hand-written. The base deployment ships exactly four routes (`/api/v1/health`, `/api/v1/auth/me`, `/api/v1/users`, `/api/v1/users/{id}`), and ADR-0003's plugin registration model assumes the same: a plugin declares its tables (which the migration generator turns into schema automatically) but must still hand-write a FastAPI handler function for every route it needs (`biffo.plugin.json`'s `api_routes[].handler`). For a plugin whose data needs are simple list/get/create/update/delete on a table, this is repetitive boilerplate that has to be re-implemented, reviewed, and kept consistent (tenant scoping, response models, error handling) by every plugin author.

Separately, testing the base deployment end-to-end (`dev.biffo.io`) surfaced that there is currently no generic way to read or write Postgres data beyond the `users` table — any new data need requires a hand-written route.

This ADR proposes an optional **generic CRUD layer**: given a table that opts in, the Core API serves list/get/create/update/delete automatically, without a plugin author writing route handlers for the common case. Because this removes the hand-written handler as the place authorization was previously expressed implicitly (via `Depends(require_auth)` and manual `tenant_id` filtering in each handler), it also requires a **declarative permission model** — the generic layer needs to know, for a table it did not write the route for, whether the caller is allowed to perform the requested operation.

This must compose with the existing decisions:

- **ADR-0001** — every table has `tenant_id`; every query must be scoped by it, generic or not.
- **ADR-0002** — the Core API remains the sole owner of the database; the generic layer is part of the Core API, not a bypass of it.
- **ADR-0003** — tables (core and plugin) are already declared in a manifest (`registry-schema.json` / `TenantScopedModel` subclasses). Permissions should extend that existing declaration, not introduce a new, separate source of truth. ADR-0003's example plugin is, not coincidentally, an RBAC plugin (`rbac_roles`, `rbac_permissions`, `rbac_role_permissions`, `rbac_user_roles`) — this ADR's permission model must not conflict with a future dedicated authorization plugin superseding it.

---

## Decision

### 1. Permissions are declared alongside the table, not discovered from the database

Add a `permissions` block to every table definition:

- **Plugin tables** — a new property on each entry in `registry-schema.json`'s `tables[]`, mirrored in the `PluginTableDefinition` Pydantic model (`models/plugin_table.py`).
- **Core tables** — an optional `__crud_permissions__: ClassVar[dict]` on `TenantScopedModel` subclasses, checked the same way. `User` deliberately does **not** declare this — `/auth/me` and `/users` stay hand-written, since they carry auth-linkage semantics a generic layer shouldn't touch.

```json
"permissions": {
  "list":   { "allowed": false, "required_role": [] },
  "read":   { "allowed": false, "required_role": [] },
  "create": { "allowed": false, "required_role": [] },
  "update": { "allowed": false, "required_role": [] },
  "delete": { "allowed": false, "required_role": [] }
}
```

`required_role` is a **list** — the caller needs at least one of the listed roles (any-of match against `caller.roles`); an empty list means any authenticated caller. **A table with no `permissions` block, or an operation with `allowed: false` (the default), is invisible to the generic CRUD layer.** This is a default-deny allowlist, not a default-expose denylist.

### 2. Discovery is a build-time artifact, not runtime introspection

`plugin_migrations.py` already walks manifests to generate Alembic migrations. Extend it to also emit a single **permissions registry** (JSON) alongside the generated schema, baked into the Lambda deployment package the same way `BIFFO_COGNITO_JWKS_JSON` is baked in for JWKS. The generic CRUD handler loads this registry once at cold start and treats it as the sole source of truth for which table/operation combinations exist and are permitted. It never queries `information_schema` or iterates `Base.metadata.tables` to decide what to expose — that would silently expose every new table the moment a migration lands, with no natural place to hang a permission rule.

### 3. Roles come from the Cognito JWT, not a database round-trip

`AuthenticatedUser` (`middleware/auth.py`) gains a `roles: list[str]` field, sourced from the `cognito:groups` claim already present in the verified JWT. No additional DB lookup is needed to authorize a request — the same token that authenticates the caller also carries their group membership.

### 4. Enforcement

For a request to the generic CRUD layer: resolve `(table, operation)` → look up in the permissions registry → if not present or `allowed: false`, 404 (not 403 — a table that isn't exposed shouldn't be distinguishable from a table that doesn't exist) → if `required_role` is non-empty, require `set(required_role) & set(caller.roles)` to be non-empty → apply `WHERE tenant_id = caller.tenant_id` unconditionally on every query, regardless of what the permissions block says. Tenant scoping is not a table-configurable permission; every table gets it, the same way `users.py` applies it today.

---

## Options Considered

### Table/Permission Discovery

#### Option A — Runtime introspection

Generic CRUD layer queries `information_schema` (or iterates SQLAlchemy's `Base.metadata.tables`) at request time to discover available tables, checking a separate authorization side-table for permissions.

**Pros:**

- No build step — new tables are immediately CRUD-accessible
- Single source of truth for "what tables exist" (the database itself)

**Cons:**

- Default-expose: every new table (including internal/plugin-migration bookkeeping tables) is reachable the moment its migration runs, unless something else explicitly blocks it
- No natural place to attach a permission rule to a table — requires a second, disconnected registry anyway, so the "single source of truth" benefit is illusory
- Couples request latency to a schema lookup (mitigated by caching, but that reintroduces a build-time-like artifact anyway)

#### Option B — Declarative manifest-based permissions _(chosen)_

Permissions live in the same manifest that already declares the table (`registry-schema.json` / `TenantScopedModel`), compiled into a registry artifact at build/migration time.

**Pros:**

- Default-deny — a table must explicitly opt in, operation by operation
- Single declaration point per table — schema and permissions can't drift into two disconnected registries
- No runtime schema introspection — cold-start load of a static artifact
- Consistent with how ADR-0003 already declares tables and routes

**Cons:**

- Every table needs an explicit permissions block before it's CRUD-accessible — more upfront authoring than "just works" discovery
- The registry artifact must be regenerated whenever a manifest changes (already true for migrations; this rides the same pipeline)

#### Option C — Delegate authorization entirely to a dedicated RBAC plugin

Don't model permissions here at all; require installing the RBAC plugin sketched in ADR-0003 (`rbac_roles`, `rbac_permissions`, `rbac_role_permissions`, `rbac_user_roles`) and call its `/rbac/check` endpoint for every generic CRUD request.

**Pros:**

- Single, richer authorization model shared by hand-written and generic routes alike
- Avoids building a second, simpler permission mechanism that the RBAC plugin would later need to subsume or coexist with

**Cons:**

- Couples the generic CRUD layer (a core capability) to an optional plugin — the base deployment would have no generic CRUD at all unless RBAC is installed
- RBAC plugin doesn't exist yet (ADR-0003 lists it as an example, not a committed deliverable) — this option blocks on work with no committed timeline

---

## Rationale

Option A's runtime introspection was rejected primarily on the default-expose problem: there is no way to introspect a schema and simultaneously know what a table's data is _for_. Permissions are semantic information that has to come from whoever defined the table, which means it has to be declared, not derived. Once that's true, discovering the table itself from the same declaration is strictly simpler than discovering it from the database and separately reconciling it against a permissions side-table.

Option C is the more complete long-term answer — a real RBAC plugin genuinely should be the authorization engine for a mature deployment — but making the generic CRUD layer _depend_ on an optional plugin means the base template ships no generic CRUD at all, which doesn't solve the problem this ADR exists to solve. The `required_role: list[str]` shape in Option B is deliberately the minimum viable authorization primitive: it is compatible with being superseded later by a real RBAC plugin (which would supply a richer `has_permission(caller, table, operation)` check in place of the simple list-intersection), without requiring the RBAC plugin to exist first.

---

## Consequences

### Positive

- New plugin tables (and future core tables) can get list/get/create/update/delete for free, without a plugin author hand-writing five route handlers.
- Default-deny means a forgotten permissions block fails closed (table invisible), not open (table world-readable).
- No new runtime dependency — the permissions registry is a static artifact loaded once at cold start, same cost model as the existing JWKS-baking pattern.
- Tenant scoping (ADR-0001) is applied unconditionally by the generic layer itself, not left to each table's author to remember.
- The `required_role: list[str]` primitive is intentionally small enough to be superseded by a future RBAC plugin (ADR-0003) without a breaking migration for tables already using it.

### Negative / Trade-offs

- Every table wanting generic CRUD access needs an explicit, correctly-authored permissions block — this is authoring overhead that a runtime-discovery approach wouldn't have.
- Two authorization primitives now exist side by side long-term: hand-written routes doing their own checks, and the generic layer's registry-driven checks. They must be kept conceptually consistent (same `caller.roles` source, same tenant-scoping rule) even though they're enforced in different code paths.
- The permissions registry artifact must be regenerated and redeployed whenever a manifest's permissions block changes — a permission change requires a deploy, not a live config toggle.
- `404` instead of `403` for disallowed operations is a deliberate information-hiding choice, but means legitimate "you don't have permission" cases look identical to "this doesn't exist" cases in logs/monitoring unless logged with more detail server-side.

### Neutral

- This ADR does not build the generic CRUD layer's HTTP surface (path conventions, pagination, filtering) — only the discovery/permission model it depends on. The route surface is a follow-up decision.
- Complex or custom-logic tables can still skip this entirely and use hand-written routes, exactly as `users.py`/`auth.py` do today — the generic layer is additive, not a replacement for hand-written routes.

---

## Compliance

**Schema enforcement:**

- `permissions` becomes part of the JSON Schema validation already run on `registry-schema.json` entries — a table definition missing the block is valid (defaults to fully denied), but a malformed one fails validation.
- `PluginTableDefinition` (Pydantic) mirrors the same shape, so plugin manifests are validated identically whether checked by the registry CI or by the CLI at install time.

**Build-time enforcement:**

- The permissions registry artifact is generated by the same migration-generation step (`plugin_migrations.py`) that already runs in CI for schema changes — a table can't gain generic CRUD exposure without that generation step running and being reviewed as part of the normal migration PR.

**Runtime enforcement:**

- The generic CRUD handler is the only code path permitted to read the permissions registry; it fails closed (table/operation not found → 404) if the registry can't be loaded at cold start, rather than falling back to any default-allow behavior.
- Tenant scoping is applied in the generic handler's query-building code, not sourced from the permissions registry — it cannot be disabled by a table's manifest.

---

## Related Decisions

- [ADR-0001](0001-single-tenant-architecture-with-multi-tenant-seam.md) — the generic CRUD layer enforces `tenant_id` scoping unconditionally on every query, independent of a table's permissions block.
- [ADR-0002](0002-api-only-data-integration-pattern.md) — the generic CRUD layer is part of the Core API; it does not grant any other service direct database access.
- [ADR-0003](0003-plugin-system-and-marketplace.md) — extends the existing table-declaration mechanism rather than introducing a parallel one; the `required_role: list[str]` primitive is deliberately small enough to be superseded by the RBAC plugin sketched there without a breaking change for tables already using it.
