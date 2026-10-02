"""Model + cost usage of agent runs, for plugins reporting per-session cost.

Wraps the service-principal routes ``GET /api/v1/internal/agent-runs/threads/{id}/usage``
and ``POST /api/v1/internal/agent-runs/usage``. Unpriced runs (NULL cost) are counted in
``unpriced_runs`` and excluded from ``total_cost_usd``, never summed as zero.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from .client import BiffoAPIClient

_BASE = "/api/v1/internal/agent-runs"


async def get_thread_usage(client: BiffoAPIClient, thread_id: str) -> dict[str, Any]:
    """Per-run model/tokens/cost and a total for every run on ``thread_id``.

    An unknown thread returns an empty result, not an error."""
    return await client.get(f"{_BASE}/threads/{quote(thread_id, safe='')}/usage")


async def get_runs_usage(client: BiffoAPIClient, run_ids: list[str]) -> dict[str, Any]:
    """Per-run model/tokens/cost and a total for an explicit list of run ids,
    in a single batched call (core caps a batch at 200 ids)."""
    return await client.post(f"{_BASE}/usage", json={"run_ids": list(run_ids)})
