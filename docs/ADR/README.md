# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the Biffo platform.

An ADR captures a significant architectural decision: the context that forced it, the options considered, what was decided, and the consequences. ADRs are immutable once accepted — if a decision is reversed, a new ADR supersedes the old one rather than editing it.

## Index

| ID                                                                    | Title                                                       | Status   | Date       |
| --------------------------------------------------------------------- | ----------------------------------------------------------- | -------- | ---------- |
| [ADR-0001](0001-single-tenant-architecture-with-multi-tenant-seam.md) | Single-Tenant Architecture with Multi-Tenant Seam           | Accepted | 2026-06-27 |
| [ADR-0002](0002-api-only-data-integration-pattern.md)                 | API-Only Data Integration and EventBridge for State Changes | Accepted | 2026-06-27 |
| [ADR-0003](0003-plugin-system-and-marketplace.md)                     | Plugin System and Marketplace                               | Accepted | 2026-06-30 |
| [ADR-0004](0004-generic-crud-layer-and-table-permissions.md)          | Generic CRUD Layer and Declarative Table Permissions        | Proposed | 2026-07-01 |
| [ADR-0005](0005-ddl-import-module.md)                                 | DDL Data-Import Module                                      | Accepted | 2026-07-02 |
| [ADR-0006](0006-core-upgrade-and-template-sync.md)                    | Core Upgrade and Template Sync                              | Accepted | 2026-07-02 |
| [ADR-0007](0007-sibling-applications.md)                              | Sibling Applications                                        | Accepted | 2026-07-03 |
| [ADR-0008](0008-endpoint-control-plane.md)                            | Endpoint Control Plane (enable-via-PR)                      | Proposed | 2026-07-03 |
| [ADR-0009](0009-internal-service-authentication.md)                   | Internal Service-to-Service Authentication (IAM SigV4)      | Accepted | 2026-07-06 |
| [ADR-0010](0010-event-registry-and-trigger-consolidation.md)          | Event Registry — one source of truth for triggers           | Accepted | 2026-07-07 |
| [ADR-0011](0011-authorization-is-a-core-concern.md)                   | Authorization is a core concern, not a plugin               | Accepted | 2026-07-07 |
| [ADR-0012](0012-identity-provider-seam.md)                            | Identity resolved through a core seam, not an owned table   | Accepted | 2026-07-19 |
| [ADR-0013](0013-plugin-extension-contract.md)                         | Plugin extension contract — declare, review, enforce        | Proposed | 2026-07-19 |
| [ADR-0014](0014-agentic-worker-framework.md)                          | Agentic workers — framework is code, workers are data       | Accepted | 2026-07-21 |
| [ADR-0015](0015-prompt-library.md)                                    | Prompt library — composable, parameterised prompt components | Proposed | 2026-07-23 |
| [ADR-0016](0016-agent-prompt-assistant.md)                          | Prompt assistant — a synchronous, streaming prompt-authoring agent | Proposed | 2026-07-23 |
| [ADR-0017](0017-user-facing-plugin-chat-modules.md)                 | User-facing plugin chat modules — generalising the buffered chat spine | Accepted | 2026-07-23 |
| [ADR-0018](0018-user-facing-plugin-hosting.md)                      | User-facing plugin hosting — a marketplace plugin as an authenticated sibling | Accepted | 2026-07-24 |
| [ADR-0019](0019-dev-staging-nat-instance-egress.md)                 | dev/staging egress defaults to a fck-nat NAT instance | Accepted | 2026-07-24 |
| [ADR-0020](0020-agent-result-delivery-on-completion.md)             | Deliver an agent's result on completion (agent-action sub-config) | Accepted | 2026-07-24 |
| [ADR-0021](0021-shared-plugin-hosting.md)                           | Plugins are pure code on shared hosting — one plugin runtime, one app shell (supersedes ADR-0018 backend; frontend per #558) | Accepted (partial) | 2026-07-25 |
| [ADR-0022](0022-product-domain-modules-are-user-owned-guests.md)    | Product-domain modules are user-owned guests hosted in the core API | Accepted | 2026-07-26 |
| [ADR-0023](0023-scheduled-workflow-actions.md)                      | Scheduled / delayed workflow actions (EventBridge Scheduler, one-time fire) | Accepted | 2026-07-26 |
| [ADR-0024](0024-hierarchy-scoped-workflow-resolver-registry.md)     | Hierarchy-scoped workflows — a resolver-registry seam, matched in Core | Accepted | 2026-07-26 |
| [ADR-0025](0025-orchestration-scoped-authorization-registry.md)     | Scoped workflow authorization — an authorizer-registry seam, checked against the submitted scope | Accepted | 2026-07-26 |
| [ADR-0026](0026-trigger-scope-reachability.md)                      | Trigger scope-reachability — reject a scope a trigger's payload can never carry | Accepted | 2026-07-26 |
| [ADR-0027](0027-agent-write-back-to-core-tables.md)                 | Agent write-back to Core tables — author-bound authority, re-checked under RLS (amends ADR-0014 §7) | Accepted | 2026-07-27 |
| [ADR-0028](0028-instance-owned-portal-admin-surfaces.md)            | Instance admin surfaces are user-owned guests in the core portal (portal counterpart to ADR-0022) | Accepted | 2026-07-31 |

## Format

New ADRs should follow the template in [template.md](template.md).

**Numbering:** zero-padded four digits, sequential. Never reuse a number.

**Statuses:**

- `Proposed` — under discussion, not yet binding
- `Accepted` — in force
- `Deprecated` — no longer recommended but not actively reversed
- `Superseded by ADR-XXXX` — replaced by a later decision
