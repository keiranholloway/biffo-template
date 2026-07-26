# ADR-0025: Scoped workflow authorization — an authorizer-registry seam, checked against the submitted scope

**Status:** Accepted
**Date:** 2026-07-26
**Deciders:** Core team

---

## Context

Every route on the user-facing orchestration workflow CRUD
(`services/api/src/api/routers/orchestration.py`) authorized by Cognito
`admin` group membership alone (`require_admin`) — all-or-nothing. Phase 1/2
(ADR-0024, docs/implementation/0003-hierarchy-scoped-workflows) gave a
workflow definition an optional hierarchy `scope`, but nothing yet lets a
non-admin caller who genuinely owns that scope (e.g. a brand manager) act on
it — the plan's own Phase 3 design deliberately left this as "a design
question for its own pass," not something to wave through as reusing
`require_admin`.

**The template has no concept of "role assignments," "brand," or any
authorization model beyond Cognito group membership and a database-held flat
`permissions` set (`AuthenticatedUser.permissions`, ADR-0004) — neither of
which carries scope.** An instance's own hierarchy and role-assignment model
(tabsii's `tabsii.user_role_assignments`, `tabsii.fn_authorized`/
`fn_ura_scope_reachable`) is exactly the kind of instance-specific knowledge
ADR-0024 already established the template must never hardcode. This is new
ground for the same reason Phase 1's scope resolver was: the template is
reusable across instances with different (or no) authorization models, so the
capability must be a registered seam, not a rewritten `require_admin`.

## Decision

**An authorizer-registry seam** (`orchestration_authz.py`), the same
"instance registers, template ships a fail-closed default" shape as the scope
resolver registry (ADR-0024) and the event registry (ADR-0010) — checked
against the caller's *submitted* target scope, not just an existing row's
stored one.

1. **`WorkflowScopeAuthorizer`**: `(caller, db, scope) -> bool`, registered
   once via `register_workflow_scope_authorizer`. The default authorizer
   returns `False` unconditionally — the router only ever consults it for a
   caller who already failed the platform-admin check, so a base deployment
   (nothing registered) keeps today's exact all-or-nothing gate.

2. **Every route becomes `require_auth` (any authenticated caller), gated
   internally by `caller is admin OR authorize_workflow_scope(caller, db,
   scope)`:**
   - **List**: returns every row to an admin; a scoped caller sees a
     *silently filtered* list (only the rows they're authorized for) — not a
     403, since "you may see some of this resource" isn't a single yes/no.
   - **Create**: checked against the *submitted* `body.scope`.
   - **Get/enable-toggle/delete**: checked against the *existing* row's
     stored scope; unauthorized reads 404, not 403 — a scoped caller sees an
     out-of-reach row exactly as "not found," never a response that confirms
     it exists.
   - **Update**: checked against **both** the existing row's scope (can they
     touch this at all — 404 if not) **and** the newly submitted scope (can
     they move it there — 403 if not). This is the ceiling: a brand-scoped
     caller can never widen their own workflow to `scope: null` (tenant-wide)
     or move it to a sibling brand, because the authorizer is asked about the
     *destination* scope exactly as it would be asked on create.
   - **Catalog**: opened to any authenticated caller (not just admin) — it
     carries no tenant-specific secrets, only what triggers/actions/
     scope-levels exist to pick from, and a scoped caller needs it to build a
     workflow at all.
   - **Run history**: deliberately left admin-only. Scoping *history* to a
     definition's owner is an explicitly deferred follow-up, not an
     oversight — the plan's ask was CRUD over definitions, and run history
     needs its own reasoning about whether a caller should see history for a
     definition since deleted, etc.

3. **The instance-side implementation is not this ADR's concern** (mirrors
   ADR-0024): tabsii's own authorizer runs a raw `SELECT
   tabsii.fn_ura_scope_reachable(...)` against the RLS-enforced session it
   already has (the same DB-side reachability check tabsii's own RLS policies
   trust for role-assignment grants, ADR module 042) rather than
   reimplementing that logic in Python.

## Options Considered

### Option A — Reuse `require_admin`, widen the Cognito `admin` group per brand

**Pros:** zero new code.
**Cons:** Cognito groups are flat and global — there is no per-brand "admin"
group to widen into, and inventing one would mean provisioning a Cognito
group per brand/region/unit, an operational explosion this template has no
business dictating to every instance.

### Option B — A generic-CRUD-style declarative permission block on `WorkflowDefinition`

**Pros:** consistent with ADR-0004's `__crud_permissions__` shape used
elsewhere.
**Cons:** the generic CRUD layer's permission model checks a flat permission
code against `caller.permissions` — it has no row-level concept at all
(scope-blind by design, matching a table with no scope column). Retrofitting
row-level scope awareness into that shared layer for one table would be a
much larger, riskier change than this router already hand-writes for
(`action_config` validation, secret redaction, "toggle enabled") — and would
still need an instance-registered scope check underneath, just laundered
through a heavier abstraction.

### Option C — Authorizer-registry seam, checked against the submitted scope (chosen)

**Pros:** mirrors a pattern this codebase already trusts (ADR-0010, ADR-0024);
checking the *submitted* scope on writes (not just the stored one) is what
delivers the escalation ceiling for free — the same function answers "can
you create here" and "can you move it here"; the default keeps every existing
deployment's behavior byte-for-byte unchanged.
**Cons:** per-row list filtering does one authorizer call per definition —
accepted as a reasonable cost for a resource that is authored by admins, not
end-users, and stays small in practice.

## Rationale

Option C is the only one that both keeps the template instance-agnostic (no
"brand"/"role assignment" concept anywhere in `biffo-template`'s own source)
and closes the escalation gap the plan itself flagged: checking the
authorizer against the *destination* scope on every write — create, and both
scopes on update — means a scoped caller can never author their way into a
wider reach than their own authorizer grants them, without the router needing
any hardcoded notion of a hierarchy or "wider than."

## Consequences

### Positive

- Zero behavior change for every existing deployment (nothing registered ⇒
  the default's unconditional `False` means only a platform admin ever
  passes — the exact `require_admin` gate, restated).
- A scoped, non-admin caller (e.g. tabsii-crm's brand-manager authoring
  surface, tabsii-crm#100) can create/read/update/delete/enable-toggle
  workflows within their own reach, with no way to escalate scope on write.
- List silently filtering (rather than 403ing outright) means a scoped
  caller's builder UI can show "your workflows" without the caller needing to
  know in advance which ones are theirs.

### Negative / Trade-offs

- Run-history scoping is explicitly out of scope for this pass — a
  non-admin's audit/debug visibility into their own workflow's run history is
  a deferred follow-up, tracked separately (tabsii-crm#100's parent epic).
- List's per-row authorizer call means an authorizer with an expensive check
  (e.g. one DB round-trip per row) scales with the number of definitions in a
  tenant — acceptable today (workflow definitions are admin-authored, not a
  high-cardinality end-user resource), revisit if that assumption changes.

### Neutral

- The authorizer signature intentionally omits the *action* being performed
  (create vs. read vs. delete) — an instance wanting per-action nuance (e.g.
  "may read a wider reach than may delete") would need a richer signature;
  not needed by tabsii's own model and not added speculatively.

## Compliance

- **Contract.** `orchestration_authz.py`'s `register_workflow_scope_authorizer`
  /`authorize_workflow_scope`, mirroring `scope_resolvers.py`'s
  `register_scope_resolver`/`resolve_scope_chain` shape exactly.
- **Router enforcement.** Every workflow-CRUD route depends on `require_auth`
  (not `require_admin`); `_require_scope_access` (create) and
  `_require_row_access` (read/update/enable/delete) are the two funnels every
  handler goes through — the same "one read funnel" discipline `_redacted`
  already established for secret redaction (#432).
- **Tests.** `test_orchestration_authz.py` covers the registry (default
  fail-closed, idempotent registration, exact-scope pass-through).
  `test_orchestration_admin_router.py` covers the router's use of it end to
  end against a fake brand-reachability authorizer: scoped create/read/list-
  filter/update/enable/delete, the two escalation-ceiling cases (widening to
  tenant-wide, moving to a sibling brand), 404-not-403 on out-of-reach reads,
  and a regression guard that a registered authorizer never narrows the
  platform admin's own reach.

## Related Decisions

- ADR-0002 — Core is the single data plane; an instance's authorizer runs
  inside Core, consulting whatever DB-side reachability logic (e.g. a raw SQL
  call into `tabsii.fn_ura_scope_reachable`) the instance already trusts.
- ADR-0004 — the generic CRUD layer's flat, scope-blind permission model;
  this ADR is the row-scoped complement for the one hand-written router that
  needs it, not a replacement for ADR-0004 elsewhere.
- ADR-0010 — the event registry's "instance registers, template ships a
  no-op default" shape, reused here for authorization the same way ADR-0024
  reused it for scope resolution.
- ADR-0024 — the scope-resolver registry this authorizer is the write-side
  counterpart to: ADR-0024 answers "does this event's ancestry match a
  scope"; this ADR answers "may this caller act on this scope."
