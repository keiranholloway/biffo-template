# ADR-0005: DDL Data-Import Module

**Status:** Accepted  
**Date:** 2026-07-02  
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

Some Biffo deployments need to load a large, hand-authored body of PostgreSQL DDL — schemas, extensions, tables, triggers, RLS policies, PostGIS geometry columns — that was designed outside the Biffo Core API's own Alembic migration history. The motivating case is a directory of numbered `.sql` files (`000_schema_setup.sql` … `012_...sql`) produced by a separate data-modelling exercise, which needs to be applied to a real deployed database without hand-rewriting it as Alembic migrations.

This is a different problem from ADR-0003's plugin system: a plugin ships application code (routes, tables declared in a manifest, UI). This is _raw DDL_ — arbitrary, already-written SQL files that must run largely as-is, including multi-statement files, dollar-quoted PL/pgSQL function bodies, and statements that depend on session state (`SET search_path`) set earlier in the same batch.

The mechanism needs two source modes — a local directory (for DDL developed alongside the Biffo project) and a GitHub repository with PAT support (for DDL maintained in its own repo) — and must fit the vendor-and-commit pattern already established for plugins (ADR-0003) rather than fetching and applying DDL live at deploy or request time.

---

## Decision

### 1. Vendor-and-commit, not live fetch

`biffo data import <name> --source <local-dir-or-github-url>` copies `.sql` files (flat, non-recursive) into `db/imports/<name>/` in the user's own repo and commits them. It never pushes or deploys. This mirrors `biffo plugin install`'s shape exactly: the CLI resolves the source (existing local directory used directly; otherwise cloned via `GitAdapter.cloneToTemp`, extended with an optional token that rewrites `https://` URLs to `https://x-access-token:<token>@host/...` before shelling out to `git clone`, never logged), copies matching files, `git add` + `git commit`.

Token resolution follows the same layered pattern used elsewhere in the CLI: `--token` flag → `BIFFO_DATA_IMPORT_TOKEN` env var → `gh auth token` → interactive masked prompt. Never written to `biffo.config.json`, never logged.

### 2. Apply via a direct Lambda event, not HTTP

`biffo data apply <name> --env <environment>` resolves the environment's Terraform state (same inline state-bucket fallback chain already duplicated in `deploy.ts`/`teardown.ts`), reads the `core_api_lambda_name` Terraform output, and invokes the Core API Lambda directly with `{"source": "biffo:ddl-import", "directory": "<name>"}`. `main.py`'s `lambda_handler()` dispatches this event type before falling through to the normal Mangum/FastAPI HTTP path — the same pattern already used for `"biffo:db-init"`.

Applying via a direct Lambda invocation (rather than an HTTP route) keeps this consistent with `db-init` and avoids exposing a schema-mutating endpoint on the public API surface.

### 3. One connection per batch, not per file

The target DDL is session-stateful: an early file does `SET search_path TO tabsii, public`, and a later file repeats `SET search_path` before referencing unqualified functions. Running each file on its own connection would silently resolve later files' unqualified references into the wrong schema. `_run_ddl_import()` therefore opens **one** raw connection for the entire batch — via `engine.begin()` → `conn.get_raw_connection()` → `.driver_connection`, the underlying `asyncpg.Connection` — and executes each file's raw SQL text directly against it (`asyncpg_conn.execute(content)`), never through SQLAlchemy's `text()`, which parses `:`-style bind markers and would misinterpret arbitrary SQL content (e.g. `::` casts, dollar-quoted bodies). Each file runs in its own transaction on that shared connection, so session state from an earlier file carries forward into later ones while a mid-batch failure still only rolls back the file that caused it.

### 4. Checksum-based idempotency via an ordinary Alembic table

Applied files are tracked in `ddl_import_history` — an ordinary `TenantScopedModel` created by a real Alembic migration (`0002_create_ddl_import_history_table.py`), not a raw `CREATE TABLE IF NOT EXISTS` run outside the ORM. A unique constraint on `(tenant_id, import_name, filename)` makes a race between concurrent `apply` invocations fail clean rather than double-apply. On each `apply`:

- No row for `(import_name, filename)` → execute the file, insert a bookkeeping row in the same transaction.
- Row exists with a matching sha256 checksum → skip.
- Row exists with a **different** checksum → raise immediately, halting the whole batch. A changed already-applied file likely means later files' assumptions about the schema it produced are now stale too, so continuing would risk applying the rest against an inconsistent premise.

Using a real Alembic-managed table avoids introducing this codebase's first table exempt from ADR-0001 ("`tenant_id` on every table"), avoids running a schema-mutating `CREATE TABLE IF NOT EXISTS` statement on every single invocation, and gets migration history for free. The "chicken-and-egg" concern this might suggest — the bookkeeping table not existing yet when `apply` first runs — doesn't actually hold: `_run_db_init()` (Alembic `upgrade head`) runs unconditionally on every deploy, before anyone could plausibly trigger `biffo data apply`.

### 5. Independent of, not a replacement for, Alembic

This mechanism exists **alongside** Alembic, not instead of it. The Core API's own schema continues to evolve exclusively through Alembic migrations. DDL imports are for schemas/tables/policies that originate outside the Core API's own data model — typically a separate application domain layered on top of the same database — and are applied as an explicit, separate step (`biffo data apply`) rather than folded into `alembic upgrade head`.

### 6. Packaging

`deploy-app.yml`'s existing plugin-manifest bundling loop (which copies `services/*/biffo.plugin.json` into the Lambda zip) is joined by a second loop that copies `db/imports/<name>/*.sql` into `package/db/imports/<name>/`, using the same defensive-empty-glob style. `BIFFO_DDL_IMPORT_ROOT=/var/task/db/imports` is set alongside the existing `BIFFO_PLUGIN_SERVICES_ROOT` in each environment's Terraform `environment_variables`. The Core API Lambda's timeout is bumped to 300s in dev (from the compute module's 30s default) as a deliberate, documented choice — a DDL file expected to run longer than the configured timeout is explicitly out of scope for v1; split the file or apply it manually instead.

---

## Options Considered

### Apply Mechanism

#### Option A — Direct Lambda invocation _(chosen)_

CLI invokes the Core API Lambda directly with a `"biffo:ddl-import"` event, bypassing HTTP entirely.

**Pros:**

- Matches the existing `db-init` precedent exactly — no new dispatch pattern to learn.
- No new public API route to secure, document, or version.
- Works even if the API Gateway route table isn't configured for it.

**Cons:**

- Requires the CLI to have AWS credentials with `lambda:InvokeFunction` (already true for other bootstrap-type operations via the `biffo-bootstrap` IAM user).
- Not reachable from the portal UI without a further proxy layer — acceptable, since applying DDL is deliberately a CLI-only, human-triggered action for now.

#### Option B — Authenticated HTTP endpoint

Add `POST /api/v1/ddl-imports/{name}/apply` to the Core API, authenticated like any other route.

**Pros:**

- Reachable from the portal UI without extra plumbing.
- Standard request/response semantics, easier to test with normal HTTP tooling.

**Cons:**

- A schema-mutating endpoint on the public API surface is a larger attack surface than a Lambda invocation gated by AWS IAM.
- Diverges from the `db-init` precedent for no strong benefit at this stage.

### Batch Execution Model

#### Option A — One connection for the whole batch _(chosen)_

**Pros:**

- Correctly preserves session state (`SET search_path`) across files, matching how the target DDL was actually authored and tested.
- Matches how a human would apply the same files with `psql -f`.

**Cons:**

- A single long-lived connection for the whole batch is a slightly larger blast radius if something goes wrong mid-batch (mitigated by per-file transactions and the checksum hard-fail).

#### Option B — One connection per file

**Pros:**

- Simpler mental model; a failure only ever affects the file being applied at that moment.

**Cons:**

- Silently wrong for this specific DDL — cross-file `SET search_path` state would be lost, causing later files' unqualified references to resolve into `public` instead of the intended schema, likely without an obvious error.

### Bookkeeping Table

#### Option A — Ordinary Alembic-managed `TenantScopedModel` _(chosen)_

**Pros:**

- No exception to ADR-0001; every table still has `tenant_id`.
- No `CREATE TABLE IF NOT EXISTS` runs on every invocation.
- Full migration history, same tooling as every other table.

**Cons:**

- Requires `_run_db_init()` to have already run before `apply` can work — not a real constraint in practice, since deploy always runs Alembic first.

#### Option B — Raw `CREATE TABLE IF NOT EXISTS`, outside the ORM

**Pros:**

- Self-bootstrapping; no dependency on migration state.

**Cons:**

- First precedent in the codebase for a table outside ADR-0001's tenant-scoping discipline.
- Re-runs a DDL statement on every single `apply` invocation.
- No real migration history for the table itself.

---

## Rationale

The design deliberately reuses precedent wherever one already exists — the vendor-and-commit flow from ADR-0003, the direct-Lambda-invocation dispatch pattern from `db-init`, and ordinary `TenantScopedModel` tables — rather than inventing new patterns for a mechanism that, at its core, is "run some SQL files in order, once each." The one genuinely novel piece, raw asyncpg execution on a single shared connection, is scoped tightly (the read/decision phase still uses the ORM) and exists only because the target DDL's use of session-scoped `SET search_path` makes it a correctness requirement, not a preference.

---

## Consequences

### Positive

- DDL developed entirely outside the Biffo Core API's own migration history can still be deployed through the standard `biffo` CLI workflow.
- Idempotent by design — re-running `apply` after nothing has changed is always safe and reports everything as skipped.
- A changed already-applied file fails loudly and immediately, rather than silently reapplying or silently skipping.
- No new public API surface area.

### Negative / Trade-offs

- `db/imports/<name>/*.sql` files are only ever applied in filename-sorted order — the DDL author is responsible for correct numeric prefixes; the tool does not understand dependencies between files.
- A single DDL file that genuinely needs more than the configured Lambda timeout is out of scope for v1 and must be split or applied manually.
- No remote read-only "what's been applied" command exists yet (`biffo data status`) — deferred as a natural future extension.
- No `biffo data uninstall` — dropping already-applied DDL/live tables is a genuinely dangerous, ambiguous operation and stays a manual, human-reviewed action.

### Neutral

- This mechanism is entirely independent of Alembic; the two systems never interact beyond both running against the same database.
- `ddl_import_history` is a normal application table, visible and queryable like any other — no special-cased introspection is required to see what's been applied.

---

## Compliance

- `ddl_import_history` extends `TenantScopedModel`, so it is included automatically in every ADR-0001 tenant-scoping check.
- Raw SQL execution happens exclusively inside `services/api/src/api/main.py`'s `_run_ddl_import()`, inside `services/api/` — consistent with ADR-0002's "no DB clients outside `services/api/`" boundary, enforced by the same Ruff plugin.
- A GitHub PAT passed via `--token` is never written to `biffo.config.json` and never logged — mirroring the equivalent handling in `biffo plugin install` and `biffo init`.

---

## Related Decisions

- [ADR-0001](0001-single-tenant-architecture-with-multi-tenant-seam.md) — `ddl_import_history` is a normal `tenant_id`-scoped table; no exception is introduced.
- [ADR-0002](0002-api-only-data-integration-pattern.md) — DDL execution happens exclusively inside `services/api/`, the only service permitted to hold a database connection.
- [ADR-0003](0003-plugin-system-and-marketplace.md) — This module reuses the vendor-and-commit installation model ADR-0003 established for plugins, applied to raw DDL instead of a structured plugin manifest.
