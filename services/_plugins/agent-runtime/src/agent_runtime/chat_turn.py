"""The synchronous chat-turn path (ADR-0016, buffered amendment).

The prompt assistant is a *synchronous, buffered* thread of runs. Its ingress is
Core's existing API Gateway (with its existing Cognito auth); Core assembles the
turn's messages under the user's authority and then **synchronously invokes this
runtime** (``lambda:InvokeFunction``, ``RequestResponse``) for the LLM turn. This
module is that turn path.

It reuses the *same* OpenRouter client the async workers use (ADR-0016 §4) — one
integration, one credential, one model-handling — via its existing full-response
:meth:`~agent_runtime.openrouter.OpenRouterClient.complete`. It does **not** use
the dormant ``stream()`` method (the amendment: Python managed runtimes cannot
stream, so streaming was abandoned).

Two things make this path distinct from the EventBridge worker path, and both are
deliberate:

- **It touches neither Core nor the database.** Core has already assembled the
  messages and fenced the untrusted user input (ADR-0014 §5 / ADR-0016 §7); this
  path takes that assembled array, calls the provider, and returns the reply. The
  runtime stays a pure internal service (ADR-0002, ADR-0009 unchanged).
- **It is hard-bounded to fit the API Gateway window.** The amendment accepts a
  ~29s integration cap, so the turn caps both output tokens and wall-clock —
  clamped *downward* into the runtime's ceilings exactly like ``RunLimits`` (a
  caller can ask for less, never more). Hitting the wall clock is a returned
  error, not a killed Lambda.

The invoke payload is discriminated from an EventBridge event by the top-level
:data:`CHAT_TURN_KIND` marker (see ``main.py``); an EventBridge event never
carries it, so the worker dispatch is untouched.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

from aws_lambda_powertools import Logger

from .openrouter import LLMClient, LLMError

logger = Logger()

#: Discriminator on a direct chat-turn invoke's payload. ``main.py`` routes on it;
#: an EventBridge event (worker trigger or the reap tick) never carries it, so the
#: worker path is byte-behaviourally unchanged.
CHAT_TURN_KIND = "agent.chat.turn"
_KIND_KEY = "kind"

# Hard output ceiling (ADR-0016 §8). A worker/turn may ask for fewer tokens; it can
# never ask for more. Overridable per deployment, defaulting generously but bounded.
DEFAULT_MAX_OUTPUT_TOKENS = 1024
MAX_OUTPUT_TOKENS_ENV = "AGENT_CHAT_MAX_OUTPUT_TOKENS"

# Hard wall-clock ceiling for one turn (seconds). Sits inside the API Gateway ~29s
# integration cap the amendment accepts, with headroom for Core to assemble the
# turn, invoke, and serialise the reply within the same request. A turn that
# exceeds it returns an error rather than being killed.
DEFAULT_TIMEOUT_CEILING = 25.0
TIMEOUT_CEILING_ENV = "AGENT_CHAT_MAX_SECONDS"


def is_chat_turn(event: dict[str, Any]) -> bool:
    """Whether *event* is a direct chat-turn invoke rather than an EventBridge event.

    Keyed on the explicit :data:`CHAT_TURN_KIND` marker so the discrimination is
    unambiguous: EventBridge delivers ``source``/``detail-type``/``detail``, never
    this marker, so a worker event can never be mistaken for a chat turn (or the
    reverse).
    """
    return isinstance(event, dict) and event.get(_KIND_KEY) == CHAT_TURN_KIND


def _bounded_output_tokens(requested: Any) -> int:
    ceiling = _positive_int(os.environ.get(MAX_OUTPUT_TOKENS_ENV), DEFAULT_MAX_OUTPUT_TOKENS)
    asked = _positive_int(requested, ceiling)
    return max(1, min(asked, ceiling))


def _bounded_timeout(requested: Any) -> float:
    ceiling = _positive_float(os.environ.get(TIMEOUT_CEILING_ENV), DEFAULT_TIMEOUT_CEILING)
    asked = _positive_float(requested, ceiling)
    return max(1.0, min(asked, ceiling))


async def run_chat_turn(payload: dict[str, Any], *, llm: LLMClient) -> dict[str, Any]:
    """Run one buffered chat turn over the pre-assembled messages, returning the reply.

    *payload* is the invoke body Core sends: ``model`` (a string), ``messages`` (the
    array Core assembled — system prompt + history + fenced user turn), and optional
    ``max_output_tokens`` / ``timeout_seconds`` requests (clamped down to the
    runtime's ceilings).

    Returns a structured result rather than raising, so Core can persist a
    ``failed`` run cleanly instead of surfacing an opaque Lambda ``FunctionError``:

    - success -> ``{"ok": True, "content", "model", "finish_reason",
      "input_tokens", "output_tokens", "cost_usd"}``
    - failure -> ``{"ok": False, "error"}`` (bad payload, provider error, or the
      wall-clock cap).
    """
    model = str(payload.get("model") or "").strip()
    messages = payload.get("messages")
    if not model:
        return _error("chat turn invoke carried no model")
    if not isinstance(messages, list) or not messages:
        return _error("chat turn invoke carried no messages")

    max_tokens = _bounded_output_tokens(payload.get("max_output_tokens"))
    timeout = _bounded_timeout(payload.get("timeout_seconds"))

    try:
        response = await asyncio.wait_for(
            llm.complete(
                model=model,
                messages=list(messages),
                timeout=timeout,
                max_tokens=max_tokens,
            ),
            timeout=timeout,
        )
    except TimeoutError:
        return _error(f"Chat turn exceeded its {timeout:g}s wall clock (ADR-0016 §8 hard stop).")
    except LLMError as exc:
        return _error(f"LLM call failed: {exc}")
    except Exception as exc:  # noqa: BLE001 — a failed turn must be a clean result, never a crash
        logger.exception("Chat turn raised")
        return _error(f"Chat turn error: {exc}")

    return {
        "ok": True,
        "content": response.content,
        "model": response.model,
        "finish_reason": response.finish_reason,
        "input_tokens": response.input_tokens,
        "output_tokens": response.output_tokens,
        "cost_usd": response.cost_usd,
    }


def _error(message: str) -> dict[str, Any]:
    return {"ok": False, "error": message}


def _positive_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def _positive_float(value: Any, fallback: float) -> float:
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback
