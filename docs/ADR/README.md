# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the Biffo platform.

An ADR captures a significant architectural decision: the context that forced it, the options considered, what was decided, and the consequences. ADRs are immutable once accepted — if a decision is reversed, a new ADR supersedes the old one rather than editing it.

## Index

| ID | Title | Status | Date |
|----|-------|--------|------|
| [ADR-0001](0001-single-tenant-architecture-with-multi-tenant-seam.md) | Single-Tenant Architecture with Multi-Tenant Seam | Accepted | 2026-06-27 |
| [ADR-0002](0002-api-only-data-integration-pattern.md) | API-Only Data Integration and EventBridge for State Changes | Accepted | 2026-06-27 |

## Format

New ADRs should follow the template in [template.md](template.md).

**Numbering:** zero-padded four digits, sequential. Never reuse a number.

**Statuses:**
- `Proposed` — under discussion, not yet binding
- `Accepted` — in force
- `Deprecated` — no longer recommended but not actively reversed
- `Superseded by ADR-XXXX` — replaced by a later decision
