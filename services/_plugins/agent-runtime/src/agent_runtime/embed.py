"""The synchronous embedding path.

Core obtains embeddings without holding a provider credential: it synchronously
invokes this runtime (``RequestResponse``) with an ``embed`` payload and the
runtime calls OpenRouter's ``POST /embeddings`` with the key it already holds.
Like the chat turn (``chat_turn.py``) it touches neither Core nor the database,
and returns a structured result rather than raising so Core can surface a typed
failure instead of an opaque Lambda ``FunctionError``.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

from aws_lambda_powertools import Logger

from .openrouter import LLMError, OpenRouterClient

logger = Logger()

#: Discriminator on a direct embed invoke's payload. Mirrored by Core's
#: ``api.chat_engine.EMBED_KIND`` — keep in step.
EMBED_KIND = "agent.embed"
_KIND_KEY = "kind"

#: Ceiling on inputs per invoke; Core batches below this.
MAX_INPUTS = 64
DEFAULT_TIMEOUT_CEILING = 25.0
TIMEOUT_CEILING_ENV = "AGENT_EMBED_MAX_SECONDS"


def is_embed(event: dict[str, Any]) -> bool:
    """Whether *event* is a direct embed invoke (never true of an EventBridge event)."""
    return isinstance(event, dict) and event.get(_KIND_KEY) == EMBED_KIND


def _bounded_timeout(requested: Any) -> float:
    try:
        ceiling = float(os.environ.get(TIMEOUT_CEILING_ENV, ""))
    except ValueError:
        ceiling = 0.0
    if ceiling <= 0:
        ceiling = DEFAULT_TIMEOUT_CEILING
    try:
        asked = float(requested)
    except (TypeError, ValueError):
        asked = ceiling
    if asked <= 0:
        asked = ceiling
    return max(1.0, min(asked, ceiling))


async def run_embed(payload: dict[str, Any], *, llm: OpenRouterClient) -> dict[str, Any]:
    """Embed ``payload["texts"]`` with ``payload["model"]``.

    Success -> ``{"ok": True, "embeddings": [[...], ...], "model"}`` with one
    vector per text in input order; failure -> ``{"ok": False, "error"}``.
    """
    model = str(payload.get("model") or "").strip()
    texts = payload.get("texts")
    dimensions = payload.get("dimensions")
    if not model:
        return _error("embed invoke carried no model")
    if not isinstance(texts, list) or not texts or not all(isinstance(t, str) and t for t in texts):
        return _error("embed invoke carried no texts")
    if len(texts) > MAX_INPUTS:
        return _error(f"embed invoke carried more than {MAX_INPUTS} texts")
    if dimensions is not None and (
        not isinstance(dimensions, int) or isinstance(dimensions, bool) or dimensions <= 0
    ):
        return _error("embed invoke carried an invalid dimensions value")

    timeout = _bounded_timeout(payload.get("timeout_seconds"))
    try:
        vectors = await asyncio.wait_for(
            llm.embed(model=model, texts=list(texts), timeout=timeout, dimensions=dimensions),
            timeout=timeout,
        )
    except TimeoutError:
        return _error(f"Embedding exceeded its {timeout:g}s wall clock.")
    except LLMError as exc:
        return _error(f"LLM call failed: {exc}")
    except Exception as exc:  # noqa: BLE001 — a failed call must be a clean result, never a crash
        logger.exception("Embed raised")
        return _error(f"Embed error: {exc}")
    return {"ok": True, "embeddings": vectors, "model": model}


def _error(message: str) -> dict[str, Any]:
    return {"ok": False, "error": message}
