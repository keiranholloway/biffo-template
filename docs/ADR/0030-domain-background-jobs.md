# ADR-0030: Background jobs for product domains

**Status:** Accepted  
**Date:** 2026-10-11  
**Deciders:** Repo owner (biffo-platform#337)

---

## Context

A Core product domain sometimes needs work off the request path (e.g. text
extraction and embedding of an uploaded file). Core has no queue; plugins have
their own host. We want the smallest mechanism that keeps the same
transactional discipline as `emit_event` (ADR-0002).

## Decision

`services/api/src/api/domain_jobs.py` provides `register_job(name, handler)` and
`enqueue_job(db, name, payload)`.

- `enqueue_job` only **buffers** on the session; `get_db` dispatches after a
  successful commit, so nothing is enqueued on rollback.
- In Lambda, dispatch invokes the Core Lambda itself asynchronously with
  `{"source": "biffo:domain-job", "job": ..., "payload": ...}`. `lambda_handler`
  routes that source to the job registry before the HTTP handler. Outside
  Lambda the job runs in-process after commit.
- An unknown job name raises `UnknownJobError` at enqueue and at dispatch; it is
  never forwarded to the HTTP handler.
- The Core role gets `lambda:InvokeFunction` on its own function in
  `core-api.core.tf`. The ARN is built from the naming convention
  (`<project>-<env>-core-api`) to avoid a Terraform dependency cycle with the
  module that owns the role.

## Consequences

- Delivery is at-least-once (Lambda async retries): handlers must be idempotent.
- A failed dispatch after commit is logged, not raised; callers needing
  durability must persist job state themselves.
- Jobs are bounded by the Core Lambda timeout.
