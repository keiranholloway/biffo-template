"""The agent-agnostic buffered chat-turn engine (ADR-0016; ADR-0017 seam #2).

Extracted from the prompt assistant so *any* registered chat agent — first-party
or a marketplace plugin's — drives the same trusted turn machinery, and so the
security properties live in one place rather than per agent:

- the **resolved system prompt** (the trusted instruction channel) is always first;
- the user's message is **fenced as untrusted data** and marker-neutralised, never
  concatenated into the instruction channel (ADR-0014 §5 / ADR-0016 §7);
- bounded **thread history** (prior runs' user/assistant messages) is replayed;
- an optional first-party **context message** may sit between the instruction
  channel and the conversation (e.g. the prompt assistant's library-reference
  block) — the caller supplies it, the engine stays ignorant of what it is;
- the runtime is invoked **synchronously and buffered** (ADR-0016 amendment).

Nothing here is specific to one agent: the caller passes the resolved system
prompt and config (see :mod:`api.chat_agents`), plus optionally a context message
and a ``drop`` predicate for messages to exclude on replay. The synchronous invoke
is a ``Protocol`` (:class:`RuntimeInvoker`) so callers stay testable without boto3
or a live Lambda, mirroring ``endpoint_control.py``.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from aws_lambda_powertools import Logger

logger = Logger()

Message = dict[str, Any]

SYSTEM = "system"
USER = "user"
ASSISTANT = "assistant"

#: Discriminator + wire contract for the direct chat-turn invoke of the runtime.
#: Mirrors ``agent_runtime.chat_turn.CHAT_TURN_KIND`` — keep in step.
CHAT_TURN_KIND = "agent.chat.turn"

#: Fence markers around untrusted content — identical to
#: ``agent_runtime.messages.UNTRUSTED_OPEN`` / ``UNTRUSTED_CLOSE``. Core cannot
#: import that plugin module (separate package), so the correspondence is by
#: convention — keep the two in step.
UNTRUSTED_OPEN = "<untrusted-context>"
UNTRUSTED_CLOSE = "</untrusted-context>"

_MARKER_PATTERN = re.compile(r"</?untrusted-(?:context|tool-result)\b[^>]*>", re.IGNORECASE)
NEUTRALISED_MARKER = "[neutralised-marker]"


def neutralise_markers(body: str) -> str:
    """Strip anything that looks like an untrusted-fence marker out of content, so
    it cannot close its own fence and impersonate the trusted side."""
    return _MARKER_PATTERN.sub(NEUTRALISED_MARKER, body)


def system_message(system_prompt: str) -> Message:
    """The instruction channel: the agent's resolved system prompt. Trusted, and
    resolved server-side from the registry by key — never user-supplied
    (ADR-0016 §1 / ADR-0017 §1)."""
    return {"role": SYSTEM, "content": system_prompt}


def user_turn_message(text: str) -> Message:
    """The user's turn as *untrusted data*, fenced and marker-neutralised.

    The text is never concatenated into the system/instruction channel; it is its
    own ``user`` message wrapped in the untrusted fence (ADR-0014 §5 / ADR-0016 §7),
    with any embedded fence marker neutralised first.
    """
    body = neutralise_markers(text)
    return {"role": USER, "content": f"{UNTRUSTED_OPEN}\n{body}\n{UNTRUSTED_CLOSE}"}


def thread_history(
    prior_messages: list[Message],
    *,
    limit: int,
    drop: Callable[[Message], bool] | None = None,
) -> list[Message]:
    """The conversational history to replay, drawn from prior runs' transcripts.

    Keeps the ``user``/``assistant`` exchange in order and drops per-run system
    messages (the engine re-adds the single system prompt fresh each turn). An
    optional ``drop`` predicate excludes further messages the caller re-derives each
    turn (e.g. a stale first-party context block) so they are not replayed stale.
    Bounded to the most recent *limit* messages (ADR-0016 §8); the oldest are
    dropped first so the newest context survives.
    """
    conversational = [
        m
        for m in prior_messages
        if m.get("role") in (USER, ASSISTANT) and not (drop(m) if drop is not None else False)
    ]
    if limit >= 0:
        conversational = conversational[-limit:] if limit else []
    return conversational


def assemble_turn(
    system_prompt: str,
    prior_messages: list[Message],
    user_text: str,
    *,
    limit: int,
    context_message: Message | None = None,
    drop: Callable[[Message], bool] | None = None,
) -> list[Message]:
    """The full message array for one turn: system + [context] + history + fenced user.

    This is what Core hands the runtime (ADR-0016 §5: Core assembles the context;
    the runtime receives it assembled). The system prompt is trusted and first; the
    optional first-party ``context_message`` sits *between* the instruction channel
    and the conversation; the new user turn is untrusted and last.
    """
    messages: list[Message] = [system_message(system_prompt)]
    if context_message is not None:
        messages.append(context_message)
    messages.extend(thread_history(prior_messages, limit=limit, drop=drop))
    messages.append(user_turn_message(user_text))
    return messages


@dataclass(frozen=True)
class ChatTurnResult:
    """The runtime's reply to one buffered chat turn (ADR-0016)."""

    content: str
    model: str | None = None
    finish_reason: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None


class RuntimeInvocationError(RuntimeError):
    """The runtime Lambda could not be invoked, or returned an unusable reply."""


class RuntimeInvoker(Protocol):
    """Synchronously invokes the agent runtime for one chat turn and returns its reply."""

    def invoke_chat_turn(
        self, *, model: str, messages: list[Message], max_output_tokens: int, timeout_seconds: float
    ) -> ChatTurnResult: ...


class LambdaRuntimeInvoker:
    """Default :class:`RuntimeInvoker` — invokes the runtime Lambda over IAM.

    The internal Core->runtime interaction from ADR-0016's amendment: IAM-authed,
    ``RequestResponse``, not EventBridge and not a public surface. boto3 is imported
    lazily (provided by the Lambda runtime) and the client is reused across warm
    invocations, matching ``endpoint_control.LambdaSignerInvoker``.
    """

    def __init__(self, function_name: str, client: Any = None) -> None:
        self._function_name = function_name
        self._client = client

    def invoke_chat_turn(
        self, *, model: str, messages: list[Message], max_output_tokens: int, timeout_seconds: float
    ) -> ChatTurnResult:
        if self._client is None:
            import boto3

            self._client = boto3.client("lambda")
        payload = {
            "kind": CHAT_TURN_KIND,
            "model": model,
            "messages": messages,
            "max_output_tokens": max_output_tokens,
            "timeout_seconds": timeout_seconds,
        }
        response = self._client.invoke(
            FunctionName=self._function_name,
            InvocationType="RequestResponse",
            Payload=json.dumps(payload).encode("utf-8"),
        )
        if response.get("FunctionError"):
            logger.error(
                "Agent runtime returned an unhandled error on a chat turn",
                extra={"function_error": response["FunctionError"]},
            )
            raise RuntimeInvocationError("the agent runtime failed to process the turn")
        body = response["Payload"].read()
        try:
            result = json.loads(body)
        except (ValueError, TypeError) as exc:
            raise RuntimeInvocationError("the agent runtime returned an unreadable reply") from exc
        return _result_from_payload(result)


def _result_from_payload(result: Any) -> ChatTurnResult:
    """Normalise the runtime's returned dict into a :class:`ChatTurnResult`.

    The runtime returns a *structured* failure (``{"ok": False, "error": ...}``)
    rather than raising, so a provider error becomes a clean failed run rather than
    an opaque Lambda ``FunctionError``. Both that and any malformed reply raise
    :class:`RuntimeInvocationError` here — the caller records the run as failed.
    """
    if not isinstance(result, dict):
        raise RuntimeInvocationError("the agent runtime returned an unexpected reply")
    if not result.get("ok"):
        raise RuntimeInvocationError(str(result.get("error") or "the agent runtime turn failed"))
    return ChatTurnResult(
        content=str(result.get("content") or ""),
        model=_opt_str(result.get("model")),
        finish_reason=_opt_str(result.get("finish_reason")),
        input_tokens=_opt_int(result.get("input_tokens")),
        output_tokens=_opt_int(result.get("output_tokens")),
        cost_usd=_opt_float(result.get("cost_usd")),
    )


def _opt_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _opt_int(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _opt_float(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
