"""``embed_texts`` — batching, ordering and typed failures (api.chat_engine)."""

from __future__ import annotations

import io
import json
from typing import Any

import pytest
from api.chat_engine import (
    EMBED_KIND,
    EMBED_MAX_BATCH,
    EmbeddingError,
    LambdaRuntimeInvoker,
    RuntimeInvocationError,
    embed_texts,
)


class _FakeLambda:
    """Echoes each text's numeric value as its one-element vector."""

    def __init__(self, reply: Any = None, function_error: str | None = None) -> None:
        self.payloads: list[dict[str, Any]] = []
        self.reply = reply
        self.function_error = function_error

    def invoke(self, **kwargs: Any) -> dict[str, Any]:
        payload = json.loads(kwargs["Payload"])
        self.payloads.append(payload)
        reply = self.reply
        if reply is None:
            reply = {"ok": True, "embeddings": [[float(t)] for t in payload["texts"]]}
        out: dict[str, Any] = {"Payload": io.BytesIO(json.dumps(reply).encode())}
        if self.function_error:
            out["FunctionError"] = self.function_error
        return out


def _invoker(fake: _FakeLambda) -> LambdaRuntimeInvoker:
    return LambdaRuntimeInvoker("agent-runtime", client=fake)


def test_empty_input_makes_no_call() -> None:
    fake = _FakeLambda()
    assert embed_texts([], "m", invoker=_invoker(fake)) == []
    assert fake.payloads == []


def test_batches_at_most_64_and_preserves_input_order() -> None:
    texts = [str(i) for i in range(150)]
    fake = _FakeLambda()

    vectors = embed_texts(texts, "openai/text-embedding-3-small", 1536, invoker=_invoker(fake))

    assert [len(p["texts"]) for p in fake.payloads] == [64, 64, 22]
    assert max(len(p["texts"]) for p in fake.payloads) <= EMBED_MAX_BATCH
    assert vectors == [[float(i)] for i in range(150)]
    assert all(p["kind"] == EMBED_KIND for p in fake.payloads)
    assert all(p["dimensions"] == 1536 for p in fake.payloads)
    assert all(p["model"] == "openai/text-embedding-3-small" for p in fake.payloads)


def test_dimensions_omitted_when_unset() -> None:
    fake = _FakeLambda()
    embed_texts(["1"], "m", invoker=_invoker(fake))
    assert "dimensions" not in fake.payloads[0]


def test_provider_error_surfaces_as_a_typed_catchable_failure() -> None:
    fake = _FakeLambda(reply={"ok": False, "error": "LLM call failed: OpenRouter returned 429"})
    with pytest.raises(EmbeddingError, match="429"):
        embed_texts(["a"], "m", invoker=_invoker(fake))
    with pytest.raises(RuntimeInvocationError):
        embed_texts(["a"], "m", invoker=_invoker(fake))


def test_lambda_function_error_is_a_typed_failure() -> None:
    with pytest.raises(EmbeddingError):
        embed_texts(["1"], "m", invoker=_invoker(_FakeLambda(function_error="Unhandled")))


def test_wrong_vector_count_is_a_typed_failure() -> None:
    fake = _FakeLambda(reply={"ok": True, "embeddings": [[1.0]]})
    with pytest.raises(EmbeddingError):
        embed_texts(["a", "b"], "m", invoker=_invoker(fake))


def test_unconfigured_runtime_is_a_typed_failure() -> None:
    with pytest.raises(EmbeddingError):
        embed_texts(["a"], "m", function_name="")
