# ADR-0002: API-Only Data Integration and EventBridge for State Changes

**Status:** Accepted  
**Date:** 2026-06-27  
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

Biffo's base portal owns a PostgreSQL database that holds all core platform data. As the platform grows, it will have multiple services consuming and producing data:

- The core API service (the primary data owner)
- Authentication/user lifecycle handlers
- Future microservices built by application developers on top of Biffo
- Third-party integrations

A common pattern in early-stage platforms is to allow services to share a database directly — it is fast to build and removes a layer of indirection. However, this creates tight coupling between services at the data layer, making it impossible to evolve the schema, enforce consistent business rules, or audit data access without coordinating every consumer.

Biffo's design philosophy is that **the platform owns the data and applications are guests**. For this to hold, the access model must be enforced by more than convention.

The decision must define: how services read data, how services write data, and how services communicate the fact that something has changed.

---

## Decision

**All data access — reads and writes — goes through the Biffo Core API.** No service other than the Core API has network access or credentials to connect directly to the PostgreSQL database.

**All notification of state changes is done through EventBridge.** When the Core API mutates data, it publishes a structured event to the default EventBridge bus. Downstream services react to events; they do not poll the database.

This is enforced at three layers:

1. **Network** — the RDS instance and RDS Proxy are in private subnets. Only the Core API Lambda's security group has an inbound rule on port 5432.
2. **IAM** — database credentials live in AWS Secrets Manager. Only the Core API Lambda's execution role has `secretsmanager:GetSecretValue` permission on the database secret.
3. **Application** — no Biffo module, template, or scaffolded service ships database client libraries or connection primitives other than the Core API service.

---

## Options Considered

### Option A — Shared Database

All services connect directly to PostgreSQL. Schema is shared and access is controlled by Postgres roles.

**Pros:**

- Fast to build — no API layer for intra-platform reads
- Simple local development — one database, all services query it
- Low latency for reads

**Cons:**

- Schema changes require coordinating every consumer — tables cannot be renamed, columns cannot be removed, types cannot be changed without a multi-service migration
- Business logic (validation, audit, cascades) is spread across every service that writes — consistency is a convention, not a constraint
- Direct queries bypass audit logging — impossible to know who read or changed what without pg_audit on every query
- Impossible to add caching, rate limiting, or access control to reads without touching every service
- Breaks the tenant isolation guarantee from ADR-0001 — any service with DB access can query any tenant's data

### Option B — API-Only with EventBridge _(chosen)_

Core API owns the database exclusively. Other services call the API for data and subscribe to EventBridge for change notifications.

**Pros:**

- Schema evolution is internal to the Core API — consumers see a versioned API contract, not raw tables
- Business rules (validation, authorisation, auditing) are enforced in one place
- Tenant isolation from ADR-0001 is enforced structurally — the API validates `tenant_id` on every call
- Full audit trail: every data access is an API call, every API call can be logged
- Caching, rate limiting, and circuit breaking are addable at the API layer without touching consumers
- EventBridge decouples producers from consumers — adding a new downstream service requires no change to the Core API

**Cons:**

- Additional latency for intra-platform reads vs direct DB queries (mitigated by RDS Proxy and Lambda-to-Lambda networking within the VPC)
- More upfront work — the Core API must expose endpoints for everything services might need
- Events require schema versioning discipline — consumers must handle schema evolution in event payloads

### Option C — GraphQL Federation / BFF

A federated GraphQL layer sits in front of the database and services query it.

**Pros:**

- Flexible query composition for consumers
- Single schema for reads

**Cons:**

- Adds operational complexity (federation gateway, schema registry) with no benefit for write paths or event-driven patterns
- Does not solve the write consistency or audit problem
- Significantly more infrastructure for Phase 2 scope

---

## Rationale

Option A is the path of least initial resistance but creates compounding technical debt. Every direct DB consumer becomes a hard coupling point — the more services that exist, the harder schema evolution becomes. The first time a consumer has a bug that corrupts data, the root cause is impossible to trace. The first time a tenant isolation bug exists in a service, every tenant's data is at risk.

Option B costs more upfront but that cost is paid once in the Core API. Every service built after that is cheaper and safer because the integration contract is clear, enforced, and auditable. The EventBridge pattern specifically ensures that adding new downstream behaviour (a new microservice, a new integration) requires zero changes to the Core API — the service subscribes to existing events.

Option C is over-engineered for this stage and does not address write-path consistency.

---

## Consequences

### Positive

- The Core API is the single source of truth for all data mutations — bugs and audits are localised.
- Tenant isolation (ADR-0001) is structurally enforced — no service can accidentally query another tenant's data.
- The platform can evolve the database schema freely without coordinating microservice consumers.
- EventBridge subscriptions make it trivial to add new downstream behaviour without modifying existing services.
- Every data access is observable — API logs give a complete audit trail.
- Caching, throttling, and circuit breaking are addable to the Core API without touching consumers.

### Negative / Trade-offs

- The Core API becomes a critical dependency — if it is unavailable, no service can read or write data. Mitigation: Lambda + RDS Proxy provides high availability; API Gateway has built-in throttling.
- Read latency is higher than direct DB access. Mitigation: keep Core API and consumer Lambdas in the same VPC and availability zone; use API-level caching (API Gateway cache or ElastiCache) for hot read paths.
- Event-driven consumers must be designed to handle out-of-order delivery and at-least-once semantics — EventBridge does not guarantee ordering.
- The Core API team must anticipate the data needs of consumer services and expose appropriate endpoints. A slow API design process can block other teams.

### Neutral

- REST is the default API style for the Core API. GraphQL or gRPC can be added as additional interfaces later without violating this ADR.
- Internal service-to-service calls (Lambda invoking another Lambda) follow the same rule — they call the API, not the database.

---

## Compliance

**Network enforcement:**

- The RDS security group allows inbound port 5432 only from the Core API Lambda security group. This is enforced in the Terraform module and verified by Checkov on every plan.
- tfsec rules flag any deviation from this security group rule in CI.

**IAM enforcement:**

- The database secret ARN is granted only to the Core API Lambda execution role via an explicit `aws_iam_role_policy` resource. No other role receives this grant.
- Terraform's `moved` block and tagging conventions prevent accidental grant propagation to new Lambda roles.

**Application enforcement:**

- No Biffo module or service template ships `psycopg2`, `asyncpg`, `SQLAlchemy`, or any other database client library outside of `services/api/`.
- The `services/_template/` stub for new microservices ships an API client, not a database client.
- A CI lint rule (custom Ruff plugin) fails the build if a non-API service directory contains a database driver import.

**Event contracts:**

- All events must extend the `BiffoEvent` Pydantic base model, which enforces `source`, `tenant_id`, `schema_version`, and `detail` fields.
- Event schemas are versioned and stored in `services/api/events/schemas/`. Breaking changes require a new `schema_version`; consumers must handle both versions during a migration window.

---

## Related Decisions

- [ADR-0001](0001-single-tenant-architecture-with-multi-tenant-seam.md) — The tenant isolation guarantee from ADR-0001 depends on this ADR being enforced. Direct DB access from microservices would allow tenant data to be read without the `tenant_id` scoping the Core API enforces.
