"""The provider boundary: credential resolution, request shape, error mapping."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from agent_runtime.openrouter import LLMError, OpenRouterClient, StreamChunk
from agent_runtime.tools import TOOL_REGISTRY
from agent_runtime_fakes import FakeSsm

_PARAMETER = "/myproject/dev/agent-runtime/openrouter-api-key"
_FAKE_KEY = "not-a-real-openrouter-key"


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


# ── Tools on the wire (M3) ───────────────────────────────────────────────────


async def test_tools_are_omitted_entirely_when_a_worker_declares_none(monkeypatch):
    # §7's default. An empty `tools` array is malformed for some providers, and
    # the M1 request shape is the one that has actually run in production.
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, seen = _ok()

    await _client(handler).complete(model="m", messages=[], timeout=5.0, tools=None)
    await _client(handler).complete(model="m", messages=[], timeout=5.0, tools=[])

    assert all("tools" not in json.loads(request.content) for request in seen)


async def test_declared_tool_schemas_are_sent_verbatim(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, seen = _ok()
    schema = TOOL_REGISTRY["web_search"].to_provider_schema()

    await _client(handler).complete(model="m", messages=[], timeout=5.0, tools=[schema])

    assert json.loads(seen[0].content)["tools"] == [schema]


async def test_tool_calls_are_parsed_off_the_completion(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, _ = _ok(
        {
            "model": "m",
            "choices": [
                {
                    "message": {
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call-1",
                                "type": "function",
                                "function": {
                                    "name": "web_search",
                                    "arguments": '{"query": "acme anvils"}',
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
        }
    )

    response = await _client(handler).complete(model="m", messages=[], timeout=5.0)

    assert response.finish_reason == "tool_calls"
    assert [(c.id, c.name, c.arguments) for c in response.tool_calls] == [
        ("call-1", "web_search", {"query": "acme anvils"})
    ]
    # The original argument string is kept: the assistant message is replayed
    # verbatim on the next turn.
    assert response.tool_calls[0].to_wire()["function"]["arguments"] == '{"query": "acme anvils"}'


async def test_a_malformed_tool_call_is_skipped_rather_than_failing_the_turn(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, _ = _ok(
        {
            "model": "m",
            "choices": [
                {
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {"function": {"name": "web_search", "arguments": "{}"}},  # no id
                            {"id": "c2", "function": {"name": "", "arguments": "{}"}},  # no name
                            {
                                "id": "c3",
                                "function": {"name": "web_search", "arguments": "not json"},
                            },
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
        }
    )

    response = await _client(handler).complete(model="m", messages=[], timeout=5.0)

    # A call with no id can never be answered — a tool result is keyed to one.
    # Unparseable arguments survive as an empty object and are then rejected by
    # the tool's own schema, which is where argument validation belongs.
    assert [(c.id, c.arguments) for c in response.tool_calls] == [("c3", {})]


# --- streaming (ADR-0016 §4) -------------------------------------------------


def _sse(*events: str):
    """A MockTransport handler serving the given JSON strings as SSE `data:`
    frames, plus the terminal `[DONE]`."""
    body = ("".join(f"data: {e}\n\n" for e in events) + "data: [DONE]\n\n").encode()
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=body)

    return handler, seen


async def _drain(client: OpenRouterClient) -> tuple[list[str], StreamChunk | None]:
    deltas: list[str] = []
    done: StreamChunk | None = None
    async for chunk in client.stream(
        model="m", messages=[{"role": "user", "content": "hi"}], timeout=5.0
    ):
        if chunk.done is not None:
            done = chunk
        else:
            deltas.append(chunk.delta)
    return deltas, done


async def test_stream_yields_text_deltas_then_a_final_response(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, seen = _sse(
        '{"model": "router/model", "choices": [{"delta": {"content": "Hel"}}]}',
        '{"choices": [{"delta": {"content": "lo"}}]}',
        '{"choices": [{"delta": {}, "finish_reason": "stop"}],'
        ' "usage": {"prompt_tokens": 3, "completion_tokens": 2, "cost": 0.001}}',
    )
    deltas, done = await _drain(_client(handler))

    assert deltas == ["Hel", "lo"]
    assert done is not None and done.done is not None
    final = done.done
    assert final.content == "Hello"  # accumulated
    assert final.model == "router/model"
    assert final.finish_reason == "stop"
    assert final.output_tokens == 2
    assert final.cost_usd == 0.001
    # It asked the provider to stream and to include usage.
    assert json.loads(seen[0].content)["stream"] is True


async def test_stream_ignores_keepalives_and_unparseable_frames(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, _ = _sse(
        "",  # keepalive / blank
        "not-json",
        '{"choices": [{"delta": {"content": "ok"}}]}',
    )
    deltas, done = await _drain(_client(handler))
    assert deltas == ["ok"]
    assert done is not None and done.done is not None and done.done.content == "ok"


async def test_stream_maps_provider_error_to_llmerror(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, content=b'{"error": "rate limited"}')

    with pytest.raises(LLMError):
        async for _ in _client(handler).stream(model="m", messages=[], timeout=5.0):
            pass
