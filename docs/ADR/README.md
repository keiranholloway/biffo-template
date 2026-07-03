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

## Format

New ADRs should follow the template in [template.md](template.md).

**Numbering:** zero-padded four digits, sequential. Never reuse a number.

**Statuses:**

- `Proposed` — under discussion, not yet binding
- `Accepted` — in force
- `Deprecated` — no longer recommended but not actively reversed
- `Superseded by ADR-XXXX` — replaced by a later decision
