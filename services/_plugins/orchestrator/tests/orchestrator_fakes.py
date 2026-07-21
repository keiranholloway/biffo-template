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
from biffo_plugin_sdk import SignedCoreClient
from botocore.credentials import Credentials


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
        return [body for method, path, body in self.requests if path.endswith("/result")]

    def event_posts(self) -> list[dict[str, Any]]:
        return [body for method, path, body in self.requests if path.endswith("/events")]

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


class FakeHttpResponse:
    def __init__(self, status_code: int = 200, json_data: Any = None, text: str = "") -> None:
        self.status_code = status_code
        self._json = {} if json_data is None else json_data
        self.text = text

    def json(self) -> Any:
        return self._json


class FakeHttp:
    """Records POST calls; returns a canned response (the webhook actions)."""

    def __init__(self, status_code: int = 200, json_data: Any = None, text: str = "") -> None:
        self._status = status_code
        self._json = json_data
        self._text = text
        self.calls: list[dict[str, Any]] = []

    def post(
        self,
        url: str,
        *,
        json: Any = None,
        headers: dict[str, str] | None = None,
    ) -> FakeHttpResponse:
        self.calls.append({"url": url, "json": json, "headers": headers})
        return FakeHttpResponse(self._status, self._json, self._text)
