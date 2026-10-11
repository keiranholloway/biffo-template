"""The synchronous embed path and its dispatch."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from agent_runtime import main
from agent_runtime.embed import EMBED_KIND, MAX_INPUTS, is_embed, run_embed
from agent_runtime.openrouter import LLMError


class FakeEmbedder:
    def __init__(self, vectors: list[list[float]] | None = None, error: Exception | None = None):
        self.vectors = vectors
        self.error = error
        self.calls: list[dict[str, Any]] = []

    async def embed(self, **kwargs: Any) -> list[list[float]]:
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.vectors if self.vectors is not None else [[0.1] for _ in kwargs["texts"]]


def _event(**extra: Any) -> dict[str, Any]:
    return {"kind": EMBED_KIND, "model": "openai/text-embedding-3-small", "texts": ["a"], **extra}


def test_is_embed_recognises_only_the_marker():
    assert is_embed(_event()) is True
    assert is_embed({"kind": "agent.chat.turn"}) is False
    assert is_embed({"source": "biffo.core", "detail-type": "agent.run.requested"}) is False


async def test_a_successful_embed_returns_vectors_in_order():
    llm = FakeEmbedder([[1.0], [2.0]])
    result = await run_embed(_event(texts=["a", "b"], dimensions=1536), llm=llm)  # type: ignore[arg-type]
    assert result == {
        "ok": True,
        "embeddings": [[1.0], [2.0]],
        "model": "openai/text-embedding-3-small",
    }
    assert llm.calls[0]["dimensions"] == 1536
    assert llm.calls[0]["texts"] == ["a", "b"]


async def test_a_provider_error_is_a_clean_failure():
    result = await run_embed(_event(), llm=FakeEmbedder(error=LLMError("boom")))  # type: ignore[arg-type]
    assert result["ok"] is False
    assert "boom" in result["error"]


async def test_bad_payloads_are_rejected_without_a_provider_call():
    llm = FakeEmbedder()
    for bad in (
        _event(model=""),
        _event(texts=[]),
        _event(texts=["a"] * (MAX_INPUTS + 1)),
        _event(dimensions=0),
    ):
        assert (await run_embed(bad, llm=llm))["ok"] is False  # type: ignore[arg-type]
    assert llm.calls == []


def _ctx() -> SimpleNamespace:
    return SimpleNamespace(
        function_name="agent-runtime",
        function_version="$LATEST",
        invoked_function_arn="arn:aws:lambda:eu-west-2:123456789012:function:agent-runtime",
        memory_limit_in_mb=1024,
        aws_request_id="req-1",
    )


def test_handler_routes_an_embed_invoke(monkeypatch):
    llm = FakeEmbedder([[3.0]])
    monkeypatch.setattr(main, "_get_llm", lambda: llm)
    monkeypatch.setattr(
        main, "_get_plugin", lambda: (_ for _ in ()).throw(AssertionError("worker"))
    )

    out = main.handler(_event(), _ctx())

    assert out == {"ok": True, "embeddings": [[3.0]], "model": "openai/text-embedding-3-small"}


async def test_a_wall_clock_overrun_is_a_clean_failure():
    result = await run_embed(_event(), llm=FakeEmbedder(error=TimeoutError()))  # type: ignore[arg-type]
    assert result["ok"] is False
    assert "wall clock" in result["error"]


async def test_an_unexpected_exception_is_a_clean_failure():
    result = await run_embed(_event(), llm=FakeEmbedder(error=RuntimeError("kaput")))  # type: ignore[arg-type]
    assert result["ok"] is False
    assert "kaput" in result["error"]
