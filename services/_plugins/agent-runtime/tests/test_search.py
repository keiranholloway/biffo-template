"""Web search: credential resolution, result normalisation, and degrading well."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from agent_runtime.search import (
    MAX_RESULT_CHARS,
    BraveSearchClient,
    SearchError,
    make_web_search_executor,
    web_search_configured,
)
from agent_runtime.tools import TOOL_REGISTRY, resolve_tools
from agent_runtime_fakes import FakeSsm

_PARAMETER = "/myproject/dev/agent-runtime/brave-search-api-key"
_FAKE_KEY = "not-a-real-brave-key"

_BODY: dict[str, Any] = {
    "web": {
        "results": [
            {
                "title": "Acme Ltd",
                "url": "https://acme.example",
                "description": "<strong>Acme</strong> makes anvils in Leeds.",
            },
            {
                "title": "Acme on Companies House",
                "url": "https://find.example/acme",
                "description": "Registered 2011, 42 employees.",
            },
        ]
    }
}


def _client(handler, **kwargs: Any) -> BraveSearchClient:
    return BraveSearchClient(
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), **kwargs
    )


def _ok(body: dict[str, Any] | None = None):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=body if body is not None else _BODY)

    return handler, seen


# ── Configuration ────────────────────────────────────────────────────────────


def test_unconfigured_means_the_tool_is_not_offered(monkeypatch):
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY_PARAMETER", raising=False)

    assert web_search_configured() is False
    # The declaration still resolves — it is a registered tool — but nothing is
    # offered to the model, so a worker declaring it runs rather than failing.
    assert resolve_tools(["web_search"]) == []


def test_configuring_either_the_key_or_the_parameter_offers_the_tool(monkeypatch):
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY_PARAMETER", _PARAMETER)

    assert web_search_configured() is True
    assert [tool.name for tool in resolve_tools(["web_search"])] == ["web_search"]
    assert TOOL_REGISTRY["web_search"].is_available is web_search_configured


async def test_the_key_comes_from_ssm_with_decryption(monkeypatch):
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY_PARAMETER", _PARAMETER)
    ssm = FakeSsm({_PARAMETER: _FAKE_KEY})
    handler, seen = _ok()

    await _client(handler, ssm_client=ssm).search("acme")

    assert ssm.calls == [{"Name": _PARAMETER, "WithDecryption": True}]
    assert seen[0].headers["X-Subscription-Token"] == _FAKE_KEY


async def test_the_key_is_resolved_once_per_container(monkeypatch):
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY_PARAMETER", _PARAMETER)
    ssm = FakeSsm({_PARAMETER: _FAKE_KEY})
    handler, _ = _ok()
    client = _client(handler, ssm_client=ssm)

    await client.search("acme")
    await client.search("acme again")

    assert len(ssm.calls) == 1


async def test_a_missing_credential_is_a_search_error_not_a_silent_empty(monkeypatch):
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY_PARAMETER", raising=False)
    handler, _ = _ok()

    with pytest.raises(SearchError, match="No Brave Search credential"):
        await _client(handler).search("acme")


async def test_an_unreadable_parameter_names_the_parameter_never_a_value(monkeypatch):
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY_PARAMETER", _PARAMETER)
    handler, _ = _ok()

    with pytest.raises(SearchError, match=_PARAMETER):
        await _client(handler, ssm_client=FakeSsm({})).search("acme")


# ── The request and the answer ───────────────────────────────────────────────


async def test_it_only_ever_gets_and_sends_the_query(monkeypatch):
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", _FAKE_KEY)
    handler, seen = _ok()

    await _client(handler).search("acme anvils")

    # Read-only by construction (registry rule 1): a GET, with the query and a
    # result count, and nothing else leaving the platform.
    assert seen[0].method == "GET"
    assert dict(seen[0].url.params) == {"q": "acme anvils", "count": "5"}


async def test_results_are_normalised_and_markup_is_stripped(monkeypatch):
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", _FAKE_KEY)
    handler, _ = _ok()

    results = await _client(handler).search("acme")

    assert [r.title for r in results] == ["Acme Ltd", "Acme on Companies House"]
    assert results[0].snippet == "Acme makes anvils in Leeds."


async def test_a_provider_error_is_a_search_error_carrying_its_status(monkeypatch):
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", _FAKE_KEY)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="slow down")

    with pytest.raises(SearchError, match="429"):
        await _client(handler).search("acme")


async def test_an_answer_with_no_results_is_not_an_error(monkeypatch):
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", _FAKE_KEY)
    handler, _ = _ok({"web": {}})

    executor = make_web_search_executor(_client(handler))

    assert "No results" in await executor({"query": "acme"})


async def test_the_rendered_result_is_bounded(monkeypatch):
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", _FAKE_KEY)
    body = {
        "web": {
            "results": [
                {"title": "t", "url": "https://x.example", "description": "y" * 2000}
                for _ in range(20)
            ]
        }
    }
    handler, _ = _ok(body)

    rendered = await make_web_search_executor(_client(handler))({"query": "acme"})

    # One verbose provider answer cannot dominate a run's token budget (§8).
    assert len(rendered) <= MAX_RESULT_CHARS + 20


async def test_the_executor_refuses_an_empty_query(monkeypatch):
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", _FAKE_KEY)
    handler, seen = _ok()

    with pytest.raises(SearchError):
        await make_web_search_executor(_client(handler))({"query": "   "})

    assert seen == []
