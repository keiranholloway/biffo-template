"""The provider boundary: credential resolution, request shape, error mapping."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from agent_runtime.openrouter import LLMError, OpenRouterClient

_SECRET_ARN = "arn:aws:secretsmanager:eu-west-2:123456789012:secret:openrouter-AbCdEf"
_FAKE_KEY = "not-a-real-openrouter-key"


class FakeSecrets:
    """The one Secrets Manager call this client makes."""

    def __init__(self, secret_string: str) -> None:
        self.secret_string = secret_string
        self.calls: list[str] = []

    def get_secret_value(self, *, SecretId: str) -> dict[str, Any]:  # noqa: N803 — boto3 kwarg
        self.calls.append(SecretId)
        return {"SecretString": self.secret_string}


def _client(handler, **kwargs: Any) -> OpenRouterClient:
    return OpenRouterClient(
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), **kwargs
    )


def _ok(payload: dict[str, Any] | None = None):
    body = payload or {
        "model": "anthropic/claude-opus-4-8",
        "choices": [{"message": {"content": "enriched"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 120, "completion_tokens": 30, "cost": 0.0031},
    }
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=body)

    return handler, seen


async def test_sends_the_model_and_message_array_and_parses_usage(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, seen = _ok()

    response = await _client(handler).complete(
        model="anthropic/claude-opus-4-8",
        messages=[{"role": "system", "content": "Go"}],
        timeout=30.0,
    )

    assert response.content == "enriched"
    assert response.finish_reason == "stop"
    assert (response.input_tokens, response.output_tokens, response.cost_usd) == (120, 30, 0.0031)
    request = seen[0]
    assert request.url.path.endswith("/chat/completions")
    assert request.headers["authorization"] == f"Bearer {_FAKE_KEY}"


async def test_the_key_comes_from_secrets_manager_when_no_env_var_is_set(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY_SECRET_ARN", _SECRET_ARN)
    secrets = FakeSecrets(_FAKE_KEY)
    handler, seen = _ok()
    client = _client(handler, secrets_client=secrets)

    await client.complete(model="m", messages=[], timeout=5.0)
    await client.complete(model="m", messages=[], timeout=5.0)

    assert seen[0].headers["authorization"] == f"Bearer {_FAKE_KEY}"
    # Resolved once and cached for the warm container, not per call.
    assert secrets.calls == [_SECRET_ARN]


async def test_a_json_secret_is_unwrapped(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY_SECRET_ARN", _SECRET_ARN)
    handler, seen = _ok()
    client = _client(handler, secrets_client=FakeSecrets(f'{{"api_key": "{_FAKE_KEY}"}}'))

    await client.complete(model="m", messages=[], timeout=5.0)

    assert seen[0].headers["authorization"] == f"Bearer {_FAKE_KEY}"


async def test_missing_credential_fails_loudly(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY_SECRET_ARN", raising=False)
    handler, _ = _ok()

    with pytest.raises(LLMError, match="No OpenRouter credential"):
        await _client(handler).complete(model="m", messages=[], timeout=5.0)


async def test_a_provider_error_becomes_an_llm_error_without_the_key(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="rate limited")

    with pytest.raises(LLMError) as exc:
        await _client(handler).complete(model="m", messages=[], timeout=5.0)

    assert "429" in str(exc.value)
    # The credential must never travel in an error that lands on a run record.
    assert _FAKE_KEY not in str(exc.value)


async def test_a_transport_failure_becomes_an_llm_error(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns")

    with pytest.raises(LLMError, match="OpenRouter request failed"):
        await _client(handler).complete(model="m", messages=[], timeout=5.0)


async def test_an_empty_choices_list_is_an_error_not_an_empty_answer(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, _ = _ok({"choices": []})

    with pytest.raises(LLMError, match="no choices"):
        await _client(handler).complete(model="m", messages=[], timeout=5.0)
