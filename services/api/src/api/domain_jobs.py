"""Background jobs for Core product domains (ADR-0030).

A product domain registers a handler with ``register_job(name, handler)`` and
queues work with ``enqueue_job(db, name, payload)``. Like ``emit_event``, the
enqueue **buffers** on the request's session; ``get_db`` dispatches the buffer
only **after** the transaction commits, so a rolled-back request never runs a
job.

Dispatch:

* In Lambda (``AWS_LAMBDA_FUNCTION_NAME`` set) the Core Lambda is invoked
  asynchronously (``InvocationType="Event"``) with
  ``{"source": "biffo:domain-job", "job": name, "payload": {...}}``;
  ``lambda_handler`` routes that to :func:`run_domain_job`.
* Elsewhere (local dev, tests) the job runs in-process right after commit.

An unknown job name raises :class:`UnknownJobError`: at enqueue time (so the
request fails loudly) and again at dispatch time (so a stale invocation is
never silently dropped or routed to the HTTP handler).
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
from collections.abc import Callable
from typing import Any

from aws_lambda_powertools import Logger
from sqlalchemy.ext.asyncio import AsyncSession

logger = Logger()

JOB_SOURCE = "biffo:domain-job"

JobHandler = Callable[[dict[str, Any]], Any]

_REGISTRY: dict[str, JobHandler] = {}
_BUFFER_KEY = "biffo_pending_jobs"
_client: Any = None


class UnknownJobError(LookupError):
    """A job name with no registered handler."""


def register_job(name: str, handler: JobHandler) -> None:
    """Register ``handler`` (sync or async, called with the payload dict)."""
    if not name:
        raise ValueError("job name must be non-empty")
    existing = _REGISTRY.get(name)
    if existing is not None and existing is not handler:
        raise ValueError(f"job {name!r} is already registered")
    _REGISTRY[name] = handler


def registered_jobs() -> list[str]:
    return sorted(_REGISTRY)


def enqueue_job(db: AsyncSession, name: str, payload: dict[str, Any] | None = None) -> None:
    """Buffer a job to run after this request commits. Never runs it here."""
    if name not in _REGISTRY:
        raise UnknownJobError(f"unknown job {name!r}")
    body = payload or {}
    json.dumps(body)  # fail now, not after commit, if it cannot be serialised
    db.info.setdefault(_BUFFER_KEY, []).append((name, body))


def pending_jobs(db: AsyncSession) -> list[tuple[str, dict[str, Any]]]:
    return list(db.info.get(_BUFFER_KEY, []))


def _lambda() -> Any:
    global _client
    if _client is None:
        import boto3

        _client = boto3.client("lambda")
    return _client


def _run(name: str, payload: dict[str, Any]) -> Any:
    handler = _REGISTRY.get(name)
    if handler is None:
        raise UnknownJobError(f"unknown job {name!r}")
    result = handler(payload)
    if inspect.isawaitable(result):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.get_event_loop().run_until_complete(result)
        raise RuntimeError("async job handlers cannot run inline inside a running loop")
    return result


async def _run_inline(name: str, payload: dict[str, Any]) -> None:
    handler = _REGISTRY[name]
    result = handler(payload)
    if inspect.isawaitable(result):
        await result


async def dispatch_pending_jobs(db: AsyncSession) -> int:
    """Dispatch buffered jobs — called by ``get_db`` after a successful commit.

    Never raises into the request: the transaction has already committed.
    Returns the number dispatched.
    """
    jobs: list[tuple[str, dict[str, Any]]] = db.info.pop(_BUFFER_KEY, [])
    count = 0
    own_name = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "")
    for name, payload in jobs:
        try:
            if own_name:
                _lambda().invoke(
                    FunctionName=own_name,
                    InvocationType="Event",
                    Payload=json.dumps(
                        {"source": JOB_SOURCE, "job": name, "payload": payload}
                    ).encode(),
                )
            else:
                await _run_inline(name, payload)
            count += 1
        except Exception:
            logger.exception("Failed to dispatch domain job", extra={"job": name})
    return count


def run_domain_job(event: dict[str, Any]) -> dict[str, Any]:
    """Entry point for a ``biffo:domain-job`` Lambda event. Raises on an
    unknown job or a handler failure so the async invocation is recorded as
    failed (and retried/dead-lettered by Lambda)."""
    name = event.get("job")
    if not isinstance(name, str) or name not in _REGISTRY:
        logger.error("Unknown domain job", extra={"job": name})
        raise UnknownJobError(f"unknown job {name!r}")
    payload = event.get("payload") or {}
    logger.info("Domain job started", extra={"job": name})
    _run(name, payload)
    logger.info("Domain job completed", extra={"job": name})
    return {"job": name, "status": "completed"}
