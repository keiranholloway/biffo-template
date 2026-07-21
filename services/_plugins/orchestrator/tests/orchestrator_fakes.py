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
    """Backing store for the internal orchestration routes.

    Also serves the internal **agent-run** route the ``agent`` action calls
    (``POST /api/v1/internal/agent-runs``): ``agent_run_status`` switches it to a
    refusal, which is how the ADR-0014 §8 depth ceiling (409) reaches the plugin.
    """

    def __init__(
        self,
        runs: list[dict[str, Any]],
        *,
        agent_run_id: str = "agent-run-1",
        agent_run_status: int = 201,
        agent_run_detail: str = "Agent run refused",
    ) -> None:
        self._runs = runs
        self._agent_run_id = agent_run_id
        self._agent_run_status = agent_run_status
        self._agent_run_detail = agent_run_detail
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

    def agent_run_posts(self) -> list[dict[str, Any]]:
        return [body for method, path, body in self.requests if path.endswith("/agent-runs")]

    def _handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        self.requests.append((request.method, request.url.path, body))

        if request.url.path.endswith("/agent-runs"):
            if self._agent_run_status >= 400:
                return httpx.Response(
                    self._agent_run_status, json={"detail": self._agent_run_detail}
                )
            return httpx.Response(
                self._agent_run_status,
                json={
                    "id": self._agent_run_id,
                    "tenant_id": "default",
                    "agent_name": body.get("agent_name"),
                    "status": "pending",
                    "causation_id": body.get("causation_id"),
                    "depth": body.get("depth"),
                },
            )
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


class FlakyHttp(FakeHttp):
    """Fails the first ``failures`` POSTs, then succeeds — the retry fixture.

    ``mode="status"`` answers with ``status_code`` (a 5xx/429 the action reads as
    transient); ``mode="raise"`` raises instead, standing in for a connection
    that never completed.
    """

    def __init__(
        self,
        failures: int,
        *,
        status_code: int = 503,
        mode: str = "status",
        json_data: Any = None,
    ) -> None:
        super().__init__(200, json_data, "")
        self._failures = failures
        self._failure_status = status_code
        self._mode = mode

    def post(
        self,
        url: str,
        *,
        json: Any = None,
        headers: dict[str, str] | None = None,
    ) -> FakeHttpResponse:
        self.calls.append({"url": url, "json": json, "headers": headers})
        if len(self.calls) <= self._failures:
            if self._mode == "raise":
                raise ConnectionError("connection reset")
            return FakeHttpResponse(self._failure_status, None, "upstream unavailable")
        return FakeHttpResponse(200, self._json, "")


class AwsError(Exception):
    """Shaped like a botocore ClientError: carries ``response['Error']['Code']``."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FlakySes(FakeSes):
    """Raises an AWS error for the first ``failures`` sends, then succeeds."""

    def __init__(
        self,
        failures: int,
        *,
        code: str = "Throttling",
        message_id: str = "ses-message-1",
    ) -> None:
        super().__init__(message_id)
        self._failures = failures
        self._code = code
        self.attempts = 0

    def send_email(self, **kwargs: Any) -> dict[str, Any]:
        self.attempts += 1
        if self.attempts <= self._failures:
            raise AwsError(self._code)
        return super().send_email(**kwargs)


class FakeSsm:
    """Serves SSM parameters from a dict; records what was asked for."""

    def __init__(self, parameters: dict[str, str] | None = None) -> None:
        self.parameters = parameters or {}
        self.calls: list[dict[str, Any]] = []

    def get_parameter(
        self,
        *,
        Name: str,  # noqa: N803 — boto3's own parameter casing
        WithDecryption: bool = False,  # noqa: N803 — boto3's own parameter casing
    ) -> dict[str, Any]:
        self.calls.append({"Name": Name, "WithDecryption": WithDecryption})
        if Name not in self.parameters:
            raise KeyError(f"Parameter {Name} not found")
        return {"Parameter": {"Name": Name, "Value": self.parameters[Name]}}
