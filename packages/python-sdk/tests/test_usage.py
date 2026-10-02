"""SDK helpers for run usage (thread and run-id list)."""

from __future__ import annotations

import json

import httpx
from biffo_plugin_sdk import BiffoAPIClient, get_runs_usage, get_thread_usage


def _client(handler) -> BiffoAPIClient:
    return BiffoAPIClient(
        base_url="https://core.example.com",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


async def test_get_thread_usage_hits_thread_route():
    seen: dict[str, object] = {}

    def handle(request: httpx.Request) -> httpx.Response:
        seen["method"], seen["path"] = request.method, request.url.raw_path.decode()
        return httpx.Response(200, json={"runs": [], "unpriced_runs": 0})

    result = await get_thread_usage(_client(handle), "t/1")

    assert seen == {
        "method": "GET",
        "path": "/api/v1/internal/agent-runs/threads/t%2F1/usage",
    }
    assert result["unpriced_runs"] == 0


async def test_get_runs_usage_batches_ids_in_one_call():
    calls: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"runs": [], "total_cost_usd": 0.0})

    await get_runs_usage(_client(handle), ["a", "b", "c"])

    assert len(calls) == 1
    assert calls[0].method == "POST"
    assert calls[0].url.path == "/api/v1/internal/agent-runs/usage"
    assert json.loads(calls[0].content) == {"run_ids": ["a", "b", "c"]}
