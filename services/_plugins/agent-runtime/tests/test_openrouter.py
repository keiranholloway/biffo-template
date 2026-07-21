"""The provider boundary: credential resolution, request shape, error mapping."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from agent_runtime.openrouter import LLMError, OpenRouterClient

_PARAMETER = "/myproject/dev/agent-runtime/openrouter-api-key"
_FAKE_KEY = "not-a-real-openrouter-key"


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


async def test_the_key_comes_from_ssm_when_no_env_var_is_set(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY_PARAMETER", _PARAMETER)
    ssm = FakeSsm({_PARAMETER: _FAKE_KEY})
    handler, seen = _ok()
    client = _client(handler, ssm_client=ssm)

    await client.complete(model="m", messages=[], timeout=5.0)
    await client.complete(model="m", messages=[], timeout=5.0)

    assert seen[0].headers["authorization"] == f"Bearer {_FAKE_KEY}"
    # A SecureString must be fetched decrypted, and resolved once for the warm
    # container rather than on every call.
    assert ssm.calls == [{"Name": _PARAMETER, "WithDecryption": True}]


async def test_an_unreadable_parameter_is_a_credential_error_and_no_provider_call(monkeypatch):
    """A missing parameter or denied GetParameter must not reach the provider."""
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY_PARAMETER", _PARAMETER)
    handler, seen = _ok()
    client = _client(handler, ssm_client=FakeSsm({}))

    with pytest.raises(LLMError, match="Could not read the OpenRouter API key from SSM parameter"):
        await client.complete(model="m", messages=[], timeout=5.0)

    assert seen == []


async def test_an_empty_parameter_value_is_a_credential_error(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY_PARAMETER", _PARAMETER)
    handler, seen = _ok()
    client = _client(handler, ssm_client=FakeSsm({_PARAMETER: "  "}))

    with pytest.raises(LLMError, match="empty OpenRouter API key"):
        await client.complete(model="m", messages=[], timeout=5.0)

    assert seen == []


async def test_the_env_var_override_wins_and_never_touches_ssm(monkeypatch):
    """Local runs and tests set the key directly; AWS is never reached."""
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    monkeypatch.setenv("OPENROUTER_API_KEY_PARAMETER", _PARAMETER)
    ssm = FakeSsm({_PARAMETER: "a-different-key"})
    handler, seen = _ok()

    await _client(handler, ssm_client=ssm).complete(model="m", messages=[], timeout=5.0)

    assert seen[0].headers["authorization"] == f"Bearer {_FAKE_KEY}"
    assert ssm.calls == []


async def test_missing_credential_fails_loudly(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY_PARAMETER", raising=False)
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


async def test_a_key_fetched_from_ssm_never_appears_in_a_provider_error(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY_PARAMETER", _PARAMETER)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="unauthorized")

    client = _client(handler, ssm_client=FakeSsm({_PARAMETER: _FAKE_KEY}))
    with pytest.raises(LLMError) as exc:
        await client.complete(model="m", messages=[], timeout=5.0)

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
