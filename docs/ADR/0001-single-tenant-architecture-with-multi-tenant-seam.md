# ADR-0001: Single-Tenant Architecture with Multi-Tenant Seam

**Status:** Accepted  
**Date:** 2026-06-27  
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

Biffo is an opinionated platform template designed to accelerate business development for solopreneurs. It needs to serve three potential use cases simultaneously:

1. **Personal development tool** — used by the author to scaffold and run new projects quickly.
2. **Open-source template** — distributed for others to fork, deploy, and own their own infrastructure.
3. **Potential SaaS product** — if demand materialises, a hosted version where Biffo manages deployments on behalf of customers.

These use cases have different architectural requirements:

- Personal and open-source use optimises for **simplicity, isolation, and ownership** — each project is a standalone deployment.
- A SaaS product optimises for **unit economics and operational leverage** — shared infrastructure amortised across many customers.

A full multi-tenant architecture built prematurely adds significant complexity (row-level security, tenant-aware auth, cross-tenant isolation audits) for a use case that may never materialise. A fully single-tenant design built without foresight forecloses the SaaS option without a painful rewrite.

The decision must balance shipping speed and simplicity now against avoiding an architectural dead end later.

---

## Decision

Biffo will be built as a **single-tenant system** — each scaffold produces an independent, isolated deployment owned entirely by the deploying party.

However, the data model, API layer, and event contracts will be designed with a **multi-tenant seam**: a `tenant_id` field is a first-class concept from day one, even though it resolves to a single value (`"default"`) in all single-tenant deployments.

The seam rules are:

1. Every database table includes a `tenant_id` column (non-nullable, indexed).
2. Every API endpoint validates and scopes to `tenant_id` — it is never inferred globally from deployment context.
3. Every EventBridge event envelope includes `tenant_id` in its detail payload.
4. No application logic ever assumes `tenant_id == "default"` — it always reads the value from auth context.
5. IAM and Cognito are structured so that a tenant management layer can be bolted on without restructuring existing resources.

---

## Options Considered

### Option A — Full Single-Tenant (no seam)
Build the simplest possible system with no multi-tenancy concepts whatsoever. `tenant_id` does not exist. Auth is a single user pool with no tenant concept.

**Pros:**
- Maximum simplicity — no unused abstractions
- Fastest to build

**Cons:**
- Adding multi-tenancy later requires schema migrations on live data, API contract changes, and auth restructuring
- Forecloses the SaaS option entirely without a near-full rewrite

### Option B — Single-Tenant with Multi-Tenant Seam *(chosen)*
Build single-tenant but thread `tenant_id` through as a dormant first-class concept.

**Pros:**
- Ships with single-tenant simplicity
- Keeps the SaaS upgrade path open at minimal upfront cost
- `tenant_id` is a small, well-understood addition that doesn't complicate daily development
- Open-source users can ignore it entirely

**Cons:**
- Slightly more boilerplate in the data model and API layer
- Developers must understand why `tenant_id` exists even when it's always `"default"`

### Option C — Full Multi-Tenant from Day One
Build a proper multi-tenant system with tenant provisioning, pool isolation, cross-tenant security controls.

**Pros:**
- No future migration cost if SaaS is pursued
- Correct architecture for a hosted product

**Cons:**
- 3–5× more complex to build correctly
- Cognito pool-per-tenant vs shared pool is a hard, load-bearing choice up front
- Row-level security bugs can cause cross-tenant data leakage — a severe trust/compliance failure
- Solves a problem that may never need solving, at the cost of problems that exist today

---

## Rationale

Option B gives the most optionality for the least cost. The `tenant_id` seam is a small, disciplined addition that does not change the complexity of building on the platform. It is invisible to open-source users who never add a second tenant. If SaaS demand materialises, the upgrade path is well-defined:

1. Add a tenant provisioning service (itself a Biffo microservice)
2. Populate `tenant_id` from Cognito custom claims rather than the `"default"` constant
3. Choose an isolation model (shared DB + RLS, schema-per-tenant, or DB-per-tenant) — the data model supports all three
4. Add Cognito User Pool per tenant or a federated identity broker

The cost of not including `tenant_id` from the start is a schema migration and API contract break across every table and every endpoint — a prohibitive rewrite. The cost of including it when it turns out not to be needed is a handful of extra columns and a constant string in tests.

---

## Consequences

### Positive
- Single-tenant deployments are simple to reason about, operate, and debug.
- Each deployment is fully isolated by default — no risk of cross-customer data leakage in the common case.
- Compliance (GDPR, SOC2, HIPAA) is each deployer's own concern, not the platform's.
- The SaaS upgrade path exists and is well-scoped.
- Open-source users get a clean, self-contained deployment model.

### Negative / Trade-offs
- Every table and every API endpoint carries a `tenant_id` that is always `"default"` in single-tenant use — this is intentional but may need explanation in onboarding docs.
- Infrastructure costs are not amortised across users in the open-source model — each deployment pays for its own RDS, Cognito pool, etc.
- If SaaS is pursued, a significant (though well-scoped) migration effort is still required for the isolation model choice.

### Neutral
- The Biffo SaaS platform, if built, would itself be a Biffo deployment — the system is self-hosting by design.

---

## Compliance

- Database migrations: enforced via Alembic migration linter that rejects tables missing `tenant_id`.
- API layer: a shared FastAPI dependency `require_tenant_context()` is injected on every route and throws `500` if `tenant_id` is absent from auth context — this catches regressions in CI.
- Event contracts: a Pydantic base model `BiffoEvent` requires `tenant_id` — all event publishers inherit from it.
- These checks run in CI on every PR.

---

## Related Decisions

- [ADR-0002](0002-api-only-data-integration-pattern.md) — API-only integration is the mechanism that makes tenant isolation enforceable across microservices.
