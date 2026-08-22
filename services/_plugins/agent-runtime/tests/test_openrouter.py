"""The provider boundary: credential resolution, request shape, error mapping."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from agent_runtime.openrouter import LLMError, OpenRouterClient
from agent_runtime.tools import TOOL_REGISTRY
from agent_runtime_fakes import FakeSsm

_PARAMETER = "/myproject/dev/agent-runtime/openrouter-api-key"
_FAKE_KEY = "not-a-real-openrouter-key"

#: A real OpenRouter `:online` completion, captured 2026-08-12 against
#: `anthropic/claude-sonnet-4:online` with the estate's own key (issue #1528).
#: Not authored: an authored fixture is the recorded cause of five separate
#: defects in `biffo-plugin-marketing` (biffo-template#1514), because what an
#: author expects the wire shape to be and what the provider actually sends
#: have drifted apart before and will again.
_ONLINE_FIXTURE = Path(__file__).parent / "fixtures" / "openrouter_online_completion.json"


def _online_completion() -> dict[str, Any]:
    return json.loads(_ONLINE_FIXTURE.read_text())


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


# ── Streaming (ADR-0016 §4) ──────────────────────────────────────────────────


def _sse(*chunks: str, extra_lines: list[str] | None = None):
    """A faked OpenRouter SSE body: one `data:` frame per chunk, a keep-alive
    comment, and the terminal `[DONE]` sentinel — served as one `text/event-stream`
    response so `aiter_lines()` sees the real frame layout."""
    lines: list[str] = []
    for chunk in chunks:
        lines.append(f"data: {json.dumps({'choices': [{'delta': {'content': chunk}}]})}")
        lines.append("")  # SSE frame separator
    lines.append(": OPENROUTER PROCESSING")  # keep-alive comment — carries no text
    lines.extend(extra_lines or [])
    lines.append("data: [DONE]")
    payload = "\n".join(lines).encode()
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=payload, headers={"content-type": "text/event-stream"})

    return handler, seen


async def test_stream_yields_chunks_in_order_and_sends_stream_true(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, seen = _sse("Hel", "lo, ", "world")

    got = [
        chunk
        async for chunk in _client(handler).stream(
            model="anthropic/claude-opus-4-8",
            messages=[{"role": "system", "content": "Go"}],
            timeout=30.0,
        )
    ]

    assert got == ["Hel", "lo, ", "world"]
    request = seen[0]
    body = json.loads(request.content)
    assert body["stream"] is True
    assert body["model"] == "anthropic/claude-opus-4-8"
    assert request.url.path.endswith("/chat/completions")
    assert request.headers["authorization"] == f"Bearer {_FAKE_KEY}"


async def test_stream_skips_comments_blanks_the_sentinel_and_toolcall_only_deltas(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    # A tool-call-only delta (no `content`) and a role-open delta carry no text.
    handler, _ = _sse(
        "one",
        "two",
        extra_lines=[
            'data: {"choices": [{"delta": {"role": "assistant"}}]}',
            'data: {"choices": [{"delta": {"tool_calls": [{"index": 0}]}}]}',
            "data: not-json",
        ],
    )

    got = [chunk async for chunk in _client(handler).stream(model="m", messages=[], timeout=5.0)]

    assert got == ["one", "two"]


async def test_stream_omits_tools_when_none_declared_and_sends_them_when_declared(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, seen = _sse("x")

    async def drain(**kwargs):
        async for _ in _client(handler).stream(model="m", messages=[], timeout=5.0, **kwargs):
            pass

    await drain(tools=None)
    await drain(tools=[])
    await drain(tools=[{"type": "function", "function": {"name": "web_search"}}])

    assert "tools" not in json.loads(seen[0].content)
    assert "tools" not in json.loads(seen[1].content)
    assert json.loads(seen[2].content)["tools"] == [
        {"type": "function", "function": {"name": "web_search"}}
    ]


async def test_stream_provider_error_becomes_an_llm_error_without_the_key(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY_PARAMETER", _PARAMETER)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="unauthorized")

    client = _client(handler, ssm_client=FakeSsm({_PARAMETER: _FAKE_KEY}))
    with pytest.raises(LLMError) as exc:
        async for _ in client.stream(model="m", messages=[], timeout=5.0):
            pass

    assert "401" in str(exc.value)
    # The credential must never travel in an error that lands on a run record.
    assert _FAKE_KEY not in str(exc.value)


async def test_stream_transport_failure_becomes_an_llm_error(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns")

    with pytest.raises(LLMError, match="OpenRouter request failed"):
        async for _ in _client(handler).stream(model="m", messages=[], timeout=5.0):
            pass


async def test_complete_does_not_request_streaming(monkeypatch):
    """Regression: the streaming addition must not change the full-response path —
    `complete` still sends a request with no `stream` flag."""
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, seen = _ok()

    await _client(handler).complete(model="m", messages=[], timeout=5.0)

    assert "stream" not in json.loads(seen[0].content)


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


# ── OpenRouter web-plugin configuration on the wire (issue #903) ────────────


async def test_plugins_key_is_absent_when_web_search_is_unset(monkeypatch):
    # The fail-closed default: every run that predates this field, and every
    # worker that never asks for it, must produce a request indistinguishable
    # from before the field existed. This is the case that matters more, per
    # the issue: every existing agent run goes through this path.
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, seen = _ok()

    await _client(handler).complete(model="m", messages=[], timeout=5.0)
    await _client(handler).complete(model="m", messages=[], timeout=5.0, web_search=None)
    await _client(handler).complete(model="m", messages=[], timeout=5.0, web_search={})

    assert all("plugins" not in json.loads(request.content) for request in seen)


async def test_plugins_key_carries_max_results_when_web_search_is_set(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, seen = _ok()

    await _client(handler).complete(
        model="m", messages=[], timeout=5.0, web_search={"max_results": 8}
    )

    assert json.loads(seen[0].content)["plugins"] == [{"id": "web", "max_results": 8}]


async def test_plugins_key_omits_max_results_when_not_given(monkeypatch):
    # A worker can ask for the web plugin at OpenRouter's own default depth
    # without naming a `max_results` — the key is optional on the wire too.
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, seen = _ok()

    await _client(handler).complete(model="m", messages=[], timeout=5.0, web_search={"other": 1})

    assert json.loads(seen[0].content)["plugins"] == [{"id": "web"}]


async def test_a_non_positive_or_non_int_max_results_is_dropped_not_sent(monkeypatch):
    # OpenRouter bills max_results per result (the issue's own cost-legibility
    # concern) — a malformed value must never reach the wire as something the
    # provider might interpret and bill against.
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, seen = _ok()

    for bad in (0, -3, "8", 1.5, True):
        await _client(handler).complete(
            model="m", messages=[], timeout=5.0, web_search={"max_results": bad}
        )

    assert all(json.loads(request.content)["plugins"] == [{"id": "web"}] for request in seen)


# ── `:online` grounding citations (issue #1528) ──────────────────────────────


async def test_annotations_from_a_real_online_completion_are_carried(monkeypatch):
    """The defect, reproduced: `message.annotations` on a real `:online`
    completion used to be dropped on the floor entirely. This is the fixture
    that failed before the fix (see the module docstring for why it is captured,
    not authored)."""
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, _ = _ok(_online_completion())

    response = await _client(handler).complete(
        model="anthropic/claude-sonnet-4:online", messages=[], timeout=5.0
    )

    assert len(response.annotations) == 5
    first = response.annotations[0]
    assert first.type == "url_citation"
    assert first.url == "https://github.com/kubernetes/kubernetes/releases"
    assert first.title == "Releases · kubernetes/kubernetes · GitHub"
    # The provider's `content` field — a raw scraped page excerpt, third-party
    # content with no fencing path back to a model — is deliberately not
    # carried onto `Annotation`. See its docstring in openrouter.py.
    assert not hasattr(first, "content")
    all_urls = {a.url for a in response.annotations}
    assert all_urls == {
        "https://github.com/kubernetes/kubernetes/releases",
        "https://kubernetes.io/releases/",
        "https://endoflife.date/kubernetes",
        "https://kubernetes.io/releases/patch-releases/",
        "https://versionlog.com/kubernetes/",
    }


async def test_a_completion_with_no_annotations_key_carries_none(monkeypatch):
    """Every non-`:online` model call, and any provider that omits the key
    entirely — the overwhelmingly common case — must read as "zero citations",
    not crash or require special-casing by callers."""
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, _ = _ok()  # the module default fixture carries no `annotations` key

    response = await _client(handler).complete(model="m", messages=[], timeout=5.0)

    assert response.annotations == ()


async def test_malformed_annotation_entries_are_skipped_not_fatal(monkeypatch):
    """Mirrors `_parse_tool_calls`'s posture: one bad entry must not cost the
    whole completion, including its otherwise-valid citations."""
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, _ = _ok(
        {
            "model": "m",
            "choices": [
                {
                    "message": {
                        "content": "grounded answer",
                        "annotations": [
                            "not-a-dict",
                            {"type": "url_citation"},  # no url_citation object
                            {"type": "url_citation", "url_citation": "not-a-dict"},
                            {"type": "url_citation", "url_citation": {}},  # no url
                            {"type": "url_citation", "url_citation": {"url": "  "}},  # blank url
                            {"type": "some_future_annotation_type", "url_citation": {"url": "x"}},
                            {
                                "type": "url_citation",
                                "url_citation": {"url": "https://example.com/real"},
                            },
                        ],
                    },
                    "finish_reason": "stop",
                }
            ],
        }
    )

    response = await _client(handler).complete(model="m", messages=[], timeout=5.0)

    # Only the one well-formed entry survives; nothing raised over the rest,
    # and a missing `title` defaults to empty rather than crashing.
    assert [(a.url, a.title) for a in response.annotations] == [("https://example.com/real", "")]


async def test_a_non_list_annotations_value_is_treated_as_none(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", _FAKE_KEY)
    handler, _ = _ok(
        {
            "model": "m",
            "choices": [
                {"message": {"content": "x", "annotations": "not-a-list"}, "finish_reason": "stop"}
            ],
        }
    )

    response = await _client(handler).complete(model="m", messages=[], timeout=5.0)

    assert response.annotations == ()
