# ADR-0013: The plugin extension contract — declare, review, enforce

**Status:** Proposed
**Date:** 2026-07-19
**Deciders:** Keiran Holloway (Technical Architect)

**Note:** Sections 1–3 (declare/review/enforce; no plugin code in the Core process)
restate constraints already settled by ADR-0002 and already enforced by Accepted
ADR-0021 — treat these specific clauses as de facto binding regardless of this
document's overall Proposed status. Sections 4–8 (config_schema, secrets, UI
capabilities, http_ingress specifics) remain genuinely unscheduled and open.

---

## Context

ADR-0003 introduced plugins as installable units with declared tables, CRUD routes and an optional worker Lambda. Two years of that design surviving contact with reality have narrowed what a plugin actually is, and widened what it needs to be.

### The three tiers, stated plainly

Biffo has converged on three tiers with genuinely different coupling:

| Tier        | Tracks the version of | Ownership                                                       | Analogy                                                         |
| ----------- | --------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| **Core**    | itself                | template-owned, upgradable via `biffo core upgrade`             | the crown jewels — centrally managed, well protected            |
| **Plugin**  | its own release       | installed and reviewed per instance, upgraded by its maintainer | the DMZ — you can do more here, but you build it and you run it |
| **Sibling** | nothing               | scaffolded once, diverges intentionally                         | the user's own product                                          |

The distinction that matters is **which version something must track**, not where its code runs. The core admin UI belongs to core because it is a client of the core API's admin surface. A sibling belongs to nobody because it shares almost nothing — its frontend never calls the core API (ADR-0007), and its backend reaches core server-side through a documented HTTP contract.

Plugins sit between: they extend the **core data model**, which a sibling cannot do (ADR-0002 forbids any component but the Core API touching the database), while remaining **optional**, which core capability is not. The Plugin tier's runtime split — event/data Lambda vs. shared-host mount, selected by the manifest's `user_ingress` field — is covered by ADR-0018/ADR-0021; this section focuses on the ownership tier distinction.

### What the tier is actually for

A plugin is the sanctioned way to extend the core data model without forking template-owned code. Without it, an instance needing a core-adjacent table has nowhere legitimate to put it: adding a model to `services/api/` forks a template-owned path and conflicts on every upgrade thereafter.

The motivating cases are commodity capabilities that many deployments want and none should hand-roll:

- **Payments** — a Stripe module: tables for customers/subscriptions, a webhook receiver, API credentials.
- **Analytics instrumentation** — a Google Analytics module: a tracking ID, and a `<script>` in the portal's `<head>`.
- **Notifications, audit logging, CRM contacts, inventory** — vertical modules that are mostly tables with a thin API and sometimes a worker.

### Why the current contract cannot express any of them

Both motivating examples are **inexpressible today**. The manifest schema is `name`, `version`, `description`, `author`, `tags`, `required_core_version`, `tables`, `api_routes`, `event_subscriptions`, `infra_modules`, `ui_components`, `dependencies`. Of those, `event_subscriptions` and `infra_modules` are declared but wired to nothing. `ui_components` used to be a third — as of #1555 its `nav-link` entries render in the portal's admin nav, gated by `admin_ingress`'s required group — but `page`, `dashboard-widget`, `modal` and `dialog` entries remain declared and unread, so the field as a whole is still not the general UI mechanism this section is about (see point 3 below).

Concretely missing:

1. **No configuration mechanism.** Nowhere to put a GA tracking ID or a Stripe publishable key. No schema, no storage, no admin form.
2. **No secrets path.** `modules/plugins/_template` deliberately injects no secret (its ADR-0009 note reads "no shared secret, nothing to rotate" — true of plugin→core auth, silent on plugin→third-party). A Stripe secret key has nowhere to live.
3. **No UI mechanism for a bespoke page.** `ui_components` is read by `plugin info` for display, and — since #1555 — its `nav-link` entries populate one link in the portal's admin nav (a pointer to the plugin's own admin-hosted surface, never a portal-rendered page). That does not touch the gap this point is about: the portal is `output: 'export'`; a page must exist at build time, so a plugin installed afterwards still cannot add a portal-hosted settings screen without rebuilding the portal. `page`, `dashboard-widget`, `modal` and `dialog` remain declared and unread.
4. **No HTTP ingress.** The plugin module provisions a Lambda and an EventBridge rule. A Stripe webhook needs a public endpoint; there is no Function URL and no API Gateway route.
5. **No schema evolution.** `biffo plugin install` generates a create-table migration. An upgrade that adds a column is a different problem and is unhandled — in an area where ADR-0003's own implementation note records a production incident caused by migration-graph corruption.

### The tension to resolve

A plugin must be able to change core — its schema, its API surface, its admin UI — or it is not an extension mechanism. But core is the crown jewels, and ADR-0002 exists because arbitrary code executing in the Core API process is exactly the thing that must not happen.

The maintainer of a plugin and the administrator of a deployment are **different people with different interests**. The maintainer wants to ship changes. The administrator wants nothing to change without their say-so. A contract that serves only one of them is not a contract.

---

## Decision

**A plugin declares its requirements; the deployment administrator reviews them; the core enforces them at runtime. The maintainer proposes, the administrator disposes, core constrains.**

### 1. Declare — everything is in the manifest

No capability is available to a plugin that is not declared in `biffo.plugin.json`. There is no hidden surface, no side channel, and no runtime registration. This is already true of `tables`, `api_routes` and permissions; it is extended to configuration, secrets, UI and ingress.

A plugin that wants something undeclared does not get it. A manifest that declares something the installed core version does not understand fails the install loudly rather than degrading.

### 2. Review — install and upgrade produce a reviewable diff

`biffo plugin install` and `biffo plugin upgrade` already vendor source into the instance's repo, generate the Alembic migration, and commit — reaching the instance as a **pull request**, not a live mutation. That shape is correct and becomes the contract: the administrator sees the files, the generated migration and the declared capabilities before anything applies.

This is the mechanism by which a plugin may change core. It is deliberately slow, auditable and revertible.

### 3. Enforce — core constrains at runtime, independent of the declaration

Declaration and review are necessary but not sufficient: neither survives a compromised or buggy plugin. Core enforces regardless:

- **Tenancy** is applied by the handler, never configurable by a plugin (ADR-0001, `plugin_table.py`).
- **Permissions** default-deny; an undeclared or not-allowed operation returns 404 (ADR-0004).
- **Internal API access** requires both an `execute-api:Invoke` grant and membership of `BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST` (ADR-0009).
- **No plugin code runs in the Core API process** (ADR-0002). This is unamended and non-negotiable.

### 4. Configuration is declared, typed, and rendered generically

The manifest gains `config_schema`: typed fields with a key, label, type, optional default, validation, and a `secret` flag.

- Non-secret values are stored by core in a `plugin_config` table, tenant-scoped like everything else.
- The admin UI **renders the form from the schema**. Plugins ship no form code.
- Values are readable by the plugin's Lambda through the internal API, and by the portal for non-secret values only.

This is what makes the Google Analytics case a configuration problem rather than a code problem.

### 5. Secrets are write-only and never returned

A `config_schema` field marked `secret: true` is stored in AWS Secrets Manager, not the database.

- Written through the admin UI; **never returned by any read API**, to the portal or to anything else.
- Injected into the plugin's own Lambda environment by its Terraform module.
- Rotatable without a plugin release.

A Stripe secret key must never be retrievable through the same endpoint that serves a tracking ID. The `secret` flag is the boundary, and read paths are separated by it rather than by convention.

Note (documentation only, no design commitment): when this write path is built, it should consider reusing the isolated-credential pattern ADR-0008 already established for the PR-signer (`services/pr-signer/`, template-owned per issue #568) — a minimal, no-public-endpoint function that alone holds a sensitive credential and is invoked over IAM by the Core API, rather than the Core API holding the credential itself. A plugin secrets-write mechanism is arguably more security-sensitive than the permissions-block edit ADR-0008 isolates a credential for, so re-deriving a weaker mechanism from scratch here would be a regression, not a fresh design.

### 6. UI is declared as capabilities, rendered at runtime

Plugins do not ship React. They declare **capabilities**, which the portal fetches from a core endpoint at runtime and renders generically:

- `head_scripts` — injected into the portal's document head, with interpolation from `config_schema` values. This is the Google Analytics case.
- `nav_items` — entries in the admin navigation.
- `admin_pages` — declarative pages bound to the plugin's `config_schema` and its declared CRUD routes.

Runtime rendering is what makes this compatible with `output: 'export'`: **no portal rebuild on plugin install**. It is also consistent with how the plugin system already treats tables, routes and permissions — declaration synthesized by core. Shipping components would be the inconsistent choice.

### 7. HTTP ingress is declared and is a first-class security surface

A plugin needing a public endpoint (a payment webhook, an inbound callback) declares `http_ingress`. The plugin's Terraform module provisions a Function URL or API Gateway route accordingly.

This is the sharpest edge in the contract: it is a public, internet-facing entry point into the DMZ, created on behalf of third-party code. It is therefore declared explicitly, surfaced prominently in the install review, and never implied by any other capability.

### 8. Schema evolution is additive and validated before it is written

Plugin migrations are generated at **CLI time** into a reviewable commit, never at deploy time. ADR-0003's implementation note records why: migrations generated at Lambda `db-init` time regenerated with a different `down_revision`, corrupted the revision graph, and reported success while never applying — in production.

Upgrades follow the additive rule already established for core migrations (ADR-0006 amendment): new migrations are appended and re-chained onto the instance's actual head; existing revision ids are never rewritten. A generated chain is validated — parents resolve, one base, exactly one head, no cycles — before anything is written, and aborts loudly rather than half-succeeding.

Destructive schema changes (dropping a column, narrowing a type) are **out of scope for automatic generation**. A plugin requiring one ships it as a hand-authored migration in its own release, which the administrator reviews like any other.

---

## Options Considered

### Option A — declare, review, enforce (chosen)

**Pros:** consistent with the existing declarative design; preserves ADR-0002 absolutely; the administrator retains veto through the PR flow; works with static export; capabilities are auditable from the manifest alone.

**Cons:** expressiveness is bounded by what the schema can describe. A plugin wanting a genuinely novel UI or a non-CRUD core route cannot have it. Every new capability requires a core release that understands it, so the core gates plugin innovation.

### Option B — plugins ship code that core loads

Let plugins provide route handlers and React components that core imports.

**Rejected.** It grants arbitrary code execution inside the Core API process, which ADR-0002 forbids for good reason, and reintroduces the trust problem the DMZ model exists to solve. It also does not work with `output: 'export'` without rebuilding the portal on every install.

### Option C — plugins are full siblings with their own database

Give each plugin its own datastore and let it integrate over HTTP only.

**Rejected.** It solves the trust problem by eliminating the capability that defines the tier. A plugin that cannot extend the core data model is a sibling, and we already have those. Cross-store joins, tenancy and referential integrity all become the plugin's problem, badly.

### Option D — do nothing; keep plugins declarative-CRUD-only

**Rejected as a destination, accepted as the current state.** It is why neither motivating example can be built. But see Compliance: nothing here is urgent to implement.

---

## Consequences

### Positive

- Both motivating cases become expressible: Google Analytics is `config_schema` plus `head_scripts`; Stripe is `config_schema` with a secret, plus `http_ingress`, plus tables.
- The administrator's veto is structural, not procedural — it is the PR they must merge.
- Secrets have a defined home and a write-only path, closing a gap that would otherwise be filled by whatever the first plugin author improvised.
- Plugins cannot exceed their declaration, and the declaration is readable before installing.
- No portal rebuild on plugin install; static export is preserved.

### Negative / Trade-offs

- **Core gates plugin capability.** A plugin needing something the schema cannot express must wait for a core release. This is the deliberate cost of the DMZ boundary, and it will chafe.
- **Generic UI is worse than bespoke UI.** A declaratively-rendered admin page will never be as good as one written by hand. Accepted: plugin config screens are not where product differentiation lives.
- **`http_ingress` adds public attack surface** on behalf of third-party code. Mitigated by explicit declaration and prominent review, not eliminated.
- **More manifest surface to validate**, and each capability needs a corresponding enforcement path. Declared-but-unwired fields are how `ui_components` became misleading; every field added here must be wired or absent. (`ui_components`'s `nav-link` type was reconciled in #1555; its `page`/`dashboard-widget`/`modal`/`dialog` types are exactly the residue this bullet warns about, and remain so.)

### Neutral

- This ADR describes a contract, not an implementation. Nothing in it is built.

---

## Compliance

**This ADR is `Proposed`, and deliberately not scheduled.**

There is currently no third-party plugin, the registry ships `plugins: []`, and the first-party plugins (orchestrator, agent-runtime) are core platform capability rather than optional modules — their infrastructure is wired identically as template-owned platform capability (`infra/environments/dev/plugins.core.tf:44-63`), not installed through the plugin flow.

Building this contract before a real plugin needs it would be speculative. Designing it now is cheap and worth doing while the reasoning is fresh; implementing it now would be guessing.

**Trigger to implement:** the first genuine plugin — one that is optional, reusable across instances, and extends the core data model. Payments is the likely candidate. At that point this ADR moves to `Accepted` and is built against a real consumer, not a hypothesis.

**When implemented, in order:**

1. `config_schema` plus the `plugin_config` table and generic admin form — unblocks the most cases for the least surface.
2. Secrets path — required by the payments case, and the one with real consequences if improvised.
3. UI capabilities (`head_scripts`, `nav_items`, `admin_pages`).
4. `http_ingress` — last, because it is the largest security surface and only payments-shaped plugins need it.

Schema evolution (§8) is a constraint on all of the above rather than a separate step.

---

## Related Decisions

- [ADR-0002](0002-api-only-data-integration-pattern.md) — no component but the Core API touches the database; the reason plugins run their own Lambda and the reason §3 is non-negotiable.
- [ADR-0003](0003-plugin-system-and-marketplace.md) — the plugin system this contract extends. Its implementation note records the migration-graph incident that §8 exists to prevent.
- [ADR-0004](0004-generic-crud-layer-and-table-permissions.md) — the default-deny permission model plugins inherit.
- [ADR-0007](0007-sibling-applications.md) — the sibling tier; the boundary this ADR draws plugins against.
- [ADR-0009](0009-internal-service-authentication.md) — how a plugin's Lambda authenticates to core; the enforcement path in §3.
- [ADR-0011](0011-authorization-is-a-core-concern.md) — authorization is never a plugin. This ADR does not reopen that.
- [ADR-0005](0005-ddl-import-module.md) — raw DDL import, the adjacent mechanism for hand-authored schema. A plugin declares and ships a module; a DDL import vendors SQL somebody else wrote. The overlap is real and worth watching: if an instance's need is schema-only and single-instance, DDL import is the lighter tool.
- [ADR-0008](0008-endpoint-control-plane.md) — the isolated-credential pattern (PR-signer) §5's future secrets-write mechanism should consider reusing rather than re-deriving; see the note in §5.
