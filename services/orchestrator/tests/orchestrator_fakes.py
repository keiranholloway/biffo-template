"""In-memory fake of the Core internal orchestration API, used to test the
plugin without a real Core API or network. Mirrors the shape the internal router
(services/api/.../routers/internal_orchestration.py) produces: POST /events
returns the runs to act on, POST /runs/{id}/result records the outcome.

Uses a real ``SignedCoreClient`` over ``httpx.MockTransport`` with dummy static
credentials, so the SigV4 signing path is exercised too (the signature is pure
crypto — no network, no real AWS).
"""

from __future__ import annotations

import json
from typing import Any

import httpx
from botocore.credentials import Credentials

from orchestrator.signed_client import SignedCoreClient


class FakeCore:
    """Backing store for the internal orchestration routes."""

    def __init__(self, runs: list[dict[str, Any]]) -> None:
        self._runs = runs
        self.requests: list[tuple[str, str, dict[str, Any]]] = []

    def client(self) -> SignedCoreClient:
        transport = httpx.MockTransport(self._handle)
        return SignedCoreClient(
            base_url="https://core.example.com",
            region="eu-west-1",
            credentials=Credentials("AKIDTEST", "SECRETTEST"),
            client=httpx.AsyncClient(transport=transport),
        )

    def result_posts(self) -> list[dict[str, Any]]:
        return [
            body for method, path, body in self.requests if path.endswith("/result")
        ]

    def event_posts(self) -> list[dict[str, Any]]:
        return [
            body for method, path, body in self.requests if path.endswith("/events")
        ]

    def _handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        self.requests.append((request.method, request.url.path, body))

        if request.url.path.endswith("/events"):
            return httpx.Response(200, json={"runs": self._runs})
        if request.url.path.endswith("/result"):
            return httpx.Response(
                200,
                json={
                    "id": "run-1",
                    "tenant_id": "default",
                    "status": body.get("status"),
                },
            )
        return httpx.Response(404, json={"detail": "Not found"})


class FakeSes:
    """Records SES send_email calls; returns a canned MessageId."""

    def __init__(self, message_id: str = "ses-message-1") -> None:
        self.message_id = message_id
        self.calls: list[dict[str, Any]] = []

    def send_email(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {"MessageId": self.message_id}
