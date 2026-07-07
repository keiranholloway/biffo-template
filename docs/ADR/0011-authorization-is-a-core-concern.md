# ADR-0011: Authorization is a core concern, not a plugin

**Status:** Accepted
**Date:** 2026-07-07
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

Two earlier ADRs sketched authorization as something that could live _outside_ the
core:

- **ADR-0003** shipped a reference **`rbac` plugin** (`services/rbac/`, tables
  `rbac_roles`/`rbac_permissions`/`rbac_role_permissions`/`rbac_user_roles`) as
  the worked example of the plugin system.
- **ADR-0004** contemplated a **"future dedicated RBAC plugin"** as the eventual
  authorization engine (its Option C), and deliberately framed the generic-CRUD
  permission primitive as a stopgap "to be superseded by a real RBAC plugin."

In practice that direction was never taken, and it proved to be the wrong shape:

- **Nothing used the plugin.** The `rbac` plugin was never deployed (no Terraform
  module, its Lambda/event subscription never ran) and was read by no Core code,
  RLS policy, query, portal page, or infra. It appeared in the Plugins admin list
  only because its manifest sat on disk. It was dead weight.
- **Real deployments put authorization in the core.** Biffo Core already enforces
  authz in core — Cognito group membership plus declarative generic-CRUD
  permissions (`services/api/src/api/permissions.py`, `dependencies.py`, ADR-0004).
  Instances that need richer authorization build it into the core too: the tabsii
  instance implements full RBAC via **PostgreSQL Row-Level Security** over
  `tabsii.roles` / `tabsii.permissions` / `tabsii.user_role_assignments` — RLS
  keyed on the request's user, not an installable plugin.

Authorization is cross-cutting and security-critical: every read and write depends
on it. Making it an _optional, installable_ concern is backwards — the base system
must be secure by default, and a deployment can't reason about a security boundary
that may or may not be present.

## Decision

**Authorization is a core capability of Biffo — never a plugin.**

1. **Baseline authz is core.** Cognito group membership + declarative generic-CRUD
   table permissions (ADR-0004) are the permanent, built-in mechanism. The
   `required_role` / permission-code primitive is _not_ a stopgap awaiting a plugin
   — it is the core primitive.
2. **Richer authz is also core.** A deployment that needs finer-grained rules
   implements them in the core (e.g. Postgres RLS, as the tabsii instance does),
   owned by the deployment — not delegated to an installable plugin.
3. **The `rbac` reference plugin is removed** (`services/rbac/` and its `rbac_*`
   tables), along with the framing that positioned it as a future authorization
   engine.

This **supersedes** the authorization-as-a-plugin framing in **ADR-0003** (which
used `rbac` as its example plugin) and **ADR-0004** (Option C, and the
"superseded by a real RBAC plugin" language throughout).

## Consequences

- **The generic-CRUD permission primitive (ADR-0004) is permanent**, not a
  temporary measure. No breaking migration is pending to hand authorization to a
  plugin.
- **Plugins are for domain features, not authorization** — e.g. the orchestration
  engine (`services/orchestrator`). The plugin system's reference is now
  `_skeletons/plugin-template` (to start one) and `services/orchestrator` (a live,
  deployed plugin).
- **Instances harden authz in the core.** The tabsii RLS model
  (`db/imports/tabsii/011_rls_policies.sql`, `services/api/src/api/models/rbac.py`
  exposing `tabsii.roles`) is the pattern: authorization lives in the database and
  the Core API, where it is always present and always enforced.
- **Naming:** a core `models/rbac.py` (an instance's own roles/permissions ORM
  view) is legitimate and unrelated to the removed `services/rbac/` _plugin_ —
  they merely shared a name.
