"""In-memory fakes for the agent runtime's two boundaries: Core and the LLM.

No live network anywhere. ``FakeCore`` mirrors the shape of Core's internal
agent-run routes (``services/api/src/api/routers/internal_agents.py``) and is
served through a **real** ``SignedCoreClient`` over ``httpx.MockTransport`` with
dummy static credentials — so the ADR-0009 SigV4 signing path is exercised too
(the signature is pure crypto: no network, no real AWS). Same convention as
``services/_plugins/orchestrator/tests/orchestrator_fakes.py``.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
from agent_runtime.openrouter import LLMError, LLMResponse
from biffo_plugin_sdk import SignedCoreClient
from botocore.credentials import Credentials

_AGENT_RUNS_PATH = "/api/v1/internal/agent-runs"


def make_run(
    run_id: str = "run-1",
    *,
    status: str = "pending",
    instructions: str = "Enrich the demo request.",
    model: str = "anthropic/claude-opus-4-8",
    input_payload: dict[str, Any] | None = None,
    **snapshot_extra: Any,
) -> dict[str, Any]:
    """An ``AgentRunResponse``-shaped record, as Core's GET route returns it."""
    return {
        "id": run_id,
        "tenant_id": "default",
        "agent_name": "demo-enricher",
        "status": status,
        "run_as_kind": "system",
        "thread_id": None,
        "causation_id": None,
        "depth": 0,
        "definition_snapshot": {
            "agent_name": "demo-enricher",
            "instructions": instructions,
            "model": model,
            "max_turns": 1,
            **snapshot_extra,
        },
        "input_payload": input_payload or {"company": "Acme"},
        "messages": [],
    }


class FakeCore:
    """Backing store for the internal agent-run routes the runtime calls."""

    def __init__(
        self,
        run: dict[str, Any] | None = None,
        *,
        get_status: int = 200,
        claim_status: int = 200,
        complete_status: int = 200,
        reap_status: int = 200,
        reaped: list[dict[str, Any]] | None = None,
    ) -> None:
        self._run = run if run is not None else make_run()
        self._get_status = get_status
        # 409 is Core's answer when another invocation already owns the run
        # (ADR-0014 §5 / issue #371) — the case a duplicate delivery must lose.
        self._claim_status = claim_status
        self._complete_status = complete_status
        self._reap_status = reap_status
        self._reaped = reaped if reaped is not None else []
        self.requests: list[tuple[str, str, dict[str, Any]]] = []

    def client(self) -> SignedCoreClient:
        transport = httpx.MockTransport(self._handle)
        return SignedCoreClient(
            base_url="https://core.example.com",
            region="eu-west-2",
            credentials=Credentials("AKIDTEST", "SECRETTEST"),
            client=httpx.AsyncClient(transport=transport),
        )

    def completions(self) -> list[dict[str, Any]]:
        """Bodies POSTed to ``/agent-runs/{id}/complete``."""
        return [body for _, path, body in self.requests if path.endswith("/complete")]

    def reaps(self) -> list[str]:
        """Paths POSTed to ``/agent-runs/reap``."""
        return [path for _, path, _ in self.requests if path.endswith("/reap")]

    def claims(self) -> list[str]:
        """Paths POSTed to ``/agent-runs/{id}/claim``."""
        return [path for _, path, _ in self.requests if path.endswith("/claim")]

    def _handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}") if request.content else {}
        self.requests.append((request.method, request.url.path, body))
        path = request.url.path

        if request.method == "GET" and path.startswith(_AGENT_RUNS_PATH):
            if self._get_status >= 400:
                return httpx.Response(self._get_status, json={"detail": "Agent run not found"})
            return httpx.Response(200, json=self._run)
        if request.method == "POST" and path.endswith("/reap"):
            if self._reap_status >= 400:
                return httpx.Response(self._reap_status, json={"detail": "boom"})
            return httpx.Response(200, json=self._reaped)
        if request.method == "POST" and path.endswith("/claim"):
            if self._claim_status >= 400:
                return httpx.Response(
                    self._claim_status,
                    json={"detail": "Agent run run-1 is running, not pending"},
                )
            return httpx.Response(200, json={**self._run, "status": "running"})
        if request.method == "POST" and path.endswith("/complete"):
            if self._complete_status >= 400:
                return httpx.Response(self._complete_status, json={"detail": "Already terminal"})
            return httpx.Response(200, json={**self._run, "status": body.get("status")})
        return httpx.Response(404, json={"detail": "Not found"})


class FakeLLM:
    """Records completion calls; replays canned responses or raises.

    ``responses`` is consumed in order, the last one repeating — so a fake that
    always asks for another turn (``finish_reason="tool_calls"``) exercises the
    ``max_turns`` hard stop without any real provider.
    """

    def __init__(
        self,
        *responses: LLMResponse,
        error: Exception | None = None,
        on_call: Any | None = None,
    ) -> None:
        self.responses = list(responses) or [
            LLMResponse(
                content="done",
                model="anthropic/claude-opus-4-8",
                finish_reason="stop",
                input_tokens=10,
                output_tokens=4,
                cost_usd=0.002,
            )
        ]
        self.error = error
        self.on_call = on_call
        self.calls: list[dict[str, Any]] = []

    async def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        timeout: float,
    ) -> LLMResponse:
        self.calls.append({"model": model, "messages": messages, "timeout": timeout})
        if self.on_call is not None:
            self.on_call()
        if self.error is not None:
            raise self.error
        index = min(len(self.calls) - 1, len(self.responses) - 1)
        return self.responses[index]


def llm_error(message: str = "provider exploded") -> LLMError:
    return LLMError(message)


class FakeClock:
    """A monotonic clock that advances a fixed step on every read."""

    def __init__(self, step: float = 0.0, start: float = 0.0) -> None:
        self.now = start
        self.step = step

    def __call__(self) -> float:
        value = self.now
        self.now += self.step
        return value
