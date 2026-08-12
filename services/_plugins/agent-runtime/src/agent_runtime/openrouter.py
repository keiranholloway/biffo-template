"""The LLM boundary: OpenRouter (ADR-0014 §1).

"The LLM provider is OpenRouter, with the model selected per worker so
alternatives can be compared without a code change." Two consequences are
implemented here:

- **The model comes from the run's ``definition_snapshot``**, never from this
  module. Nothing in the runtime picks a model.
- **Provider access sits behind this client and is never exposed to worker
  definitions.** A definition names a model; it never sees a key, a base URL or a
  request shape, so changing provider later is a change to this file rather than
  a migration of every worker.

**The credential.** ``OPENROUTER_API_KEY`` is read from the environment when
present (local runs, tests); otherwise it is fetched once per warm container from
an SSM SecureString parameter named by ``OPENROUTER_API_KEY_PARAMETER``. It is
never committed, never logged, and never included in an error: the exceptions
raised below carry the provider's status and body, both of which are provider
output, and the key only ever leaves this module inside an ``Authorization``
header.

Parameter Store rather than Secrets Manager, deliberately — this is one API key
read at cold start, so rotation, versioning and cross-account policies buy
nothing, a Secrets Manager secret bills ~$0.40/month, and a SecureString on the
AWS-managed key is free at standard tier. It also matches the orchestrator's
WhatsApp credentials, so both plugin third-party credentials are fetched the
same way. A SecureString holding one key is a plain string, which is why nothing
here unwraps JSON.

The client is deliberately thin — no retries. It passes tool schemas through and
normalises tool calls back (M3), but it neither decides what tools exist
(``tools.py``) nor executes one (``loop.py``): this file is a translation layer
between the runtime's vocabulary and one provider's wire format, and staying that
way is what makes a second provider a new file rather than a fork.

**Streaming (ADR-0016 §4).** Alongside the full-response :meth:`~OpenRouterClient.complete`
the async workers use, the client exposes :meth:`~OpenRouterClient.stream`, which
issues the same chat completion with ``stream: true`` and yields the incremental
text as OpenRouter's SSE ``data:`` frames arrive. It is the *same* client, key,
base URL and model handling — one integration, one credential (ADR-0016 §4) — not
a second LLM path. Streaming is a consumer of this client (the synchronous prompt
assistant), so it lives here as a method rather than in the :class:`LLMClient`
Protocol the agent loop depends on: the loop still speaks only ``complete``.
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"

# Env var names. The direct value wins so a local run or a test never reaches for
# AWS; the parameter name is what Terraform wires in a real deployment.
_KEY_ENV = "OPENROUTER_API_KEY"  # noqa: S105 — an env var name, not a credential
_KEY_PARAMETER_ENV = "OPENROUTER_API_KEY_PARAMETER"  # noqa: S105 — likewise


class LLMError(Exception):
    """The provider call failed. Terminal for the run (ADR-0014 §5)."""


@dataclass(frozen=True)
class ToolCall:
    """One tool the model asked to run, normalised away from the wire shape.

    ``arguments`` is the parsed object the executor receives; ``arguments_json``
    is the provider's original string, kept because the assistant message is
    replayed verbatim on the next turn and a re-serialised object is not
    guaranteed to be byte-identical.
    """

    id: str
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)
    arguments_json: str = "{}"

    def to_wire(self) -> dict[str, Any]:
        """The shape this call takes inside an assistant message."""
        return {
            "id": self.id,
            "type": "function",
            "function": {"name": self.name, "arguments": self.arguments_json},
        }


@dataclass(frozen=True)
class Annotation:
    """One grounding citation OpenRouter attached to a completion (``:online``).

    Carries only ``type`` and the ``url_citation`` object's ``url``/``title`` —
    deliberately less than the provider sends. OpenRouter's ``url_citation`` also
    carries ``content``: a raw excerpt of the page it fetched. That is
    third-party content in exactly the sense a tool result is (see the module
    docstring of ``messages.py``) — arbitrary, attacker-reachable text, here
    scraped from the open web on the model's behalf — but unlike a tool result it
    has no fencing path back to a model, because nothing here re-feeds it into
    the message array a turn replays. Rather than persist an unbounded, unfenced
    blob on the run record against the chance some future caller reads it into a
    prompt unguarded, it is dropped at this boundary. A citation's URL and title
    are enough to answer "was this run grounded, and in what" — issue #1528's
    whole ask — and if a full excerpt is ever genuinely needed, it must go
    through the same fencing and redaction ``messages.py`` already applies to
    every other third-party string this runtime touches.
    """

    type: str
    url: str
    title: str

    def to_dict(self) -> dict[str, str]:
        """The shape persisted on the run record and reported per turn."""
        return {"type": self.type, "url": self.url, "title": self.title}


@dataclass(frozen=True)
class LLMResponse:
    """One completion, normalised away from the provider's wire shape."""

    content: str
    model: str
    finish_reason: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    tool_calls: tuple[ToolCall, ...] = ()
    # The citations OpenRouter attached via `message.annotations` (`:online`
    # grounding). Empty whenever the provider sent none — including every
    # non-`:online` model, which never carries this key at all — never `None`,
    # so a caller can always iterate without a null check (issue #1528).
    annotations: tuple[Annotation, ...] = ()


class LLMClient(Protocol):
    """The slice of an LLM client :class:`~agent_runtime.loop.AgentLoop` uses.

    A Protocol rather than the concrete class so the loop is testable without a
    network and so a second provider is a new implementation, not a branch.
    """

    async def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        timeout: float,
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int | None = None,
    ) -> LLMResponse: ...


class OpenRouterClient:
    """Async OpenRouter chat-completions client."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        http_client: httpx.AsyncClient | None = None,
        ssm_client: Any | None = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = (base_url or os.environ.get("OPENROUTER_BASE_URL") or "").rstrip(
            "/"
        ) or DEFAULT_BASE_URL
        self._http = http_client if http_client is not None else httpx.AsyncClient()
        self._ssm = ssm_client

    def _resolve_api_key(self) -> str:
        """The key, resolved once and cached for the life of the container.

        Env var first (local, tests), SSM second (deployed). Raises rather than
        proceeding unauthenticated — a 401 from the provider is a worse
        diagnostic than the missing-configuration message. The parameter is a
        SecureString, so the fetch always decrypts; the error path names the
        parameter, never the value it failed to read.
        """
        if self._api_key:
            return self._api_key

        env_key = os.environ.get(_KEY_ENV, "").strip()
        if env_key:
            self._api_key = env_key
            return env_key

        parameter = os.environ.get(_KEY_PARAMETER_ENV, "").strip()
        if not parameter:
            raise LLMError(f"No OpenRouter credential: set {_KEY_ENV} or {_KEY_PARAMETER_ENV}.")

        client = self._ssm
        if client is None:
            import boto3

            client = boto3.client("ssm")
            self._ssm = client
        try:
            response = client.get_parameter(Name=parameter, WithDecryption=True)
            key = str(response["Parameter"]["Value"]).strip()
        except Exception as exc:  # noqa: BLE001 — botocore raises many shapes; all are fatal here
            raise LLMError(
                f"Could not read the OpenRouter API key from SSM parameter {parameter}: {exc}"
            ) from exc

        if not key:
            raise LLMError(f"SSM parameter {parameter} holds an empty OpenRouter API key.")

        self._api_key = key
        return key

    async def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        timeout: float,
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int | None = None,
    ) -> LLMResponse:
        """One chat completion. Raises :class:`LLMError` for anything non-2xx.

        ``max_tokens`` is optional and bounds the reply length. The async worker
        path (the agent loop) never sets it and produces a request byte-identical
        to before; the synchronous chat turn (ADR-0016 §8, the amendment's ~29s API
        Gateway window) uses it as a hard output cap. It is declared on the
        :class:`LLMClient` Protocol as an optional keyword so both consumers speak
        one client, and omitted from the request body when ``None`` so the worker
        path is unchanged.
        """
        headers = {
            "Authorization": f"Bearer {self._resolve_api_key()}",
            "Content-Type": "application/json",
        }
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            # Ask OpenRouter to price the call so §8 cost accounting lands on the
            # run record rather than being reconstructed from token counts.
            "usage": {"include": True},
        }
        # Omitted entirely rather than sent empty: a worker declaring no tools
        # (the §7 default) must produce a request indistinguishable from M1's,
        # since some providers treat an empty `tools` array as malformed.
        if tools:
            body["tools"] = tools
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        try:
            response = await self._http.post(
                f"{self._base_url}/chat/completions",
                headers=headers,
                json=body,
                timeout=timeout,
            )
        except httpx.HTTPError as exc:
            raise LLMError(f"OpenRouter request failed: {exc}") from exc

        if response.status_code >= 400:
            # Provider output only — the request headers (which carry the key)
            # are never echoed into the message.
            raise LLMError(f"OpenRouter returned {response.status_code}: {response.text[:500]}")

        return _parse_completion(response.json(), fallback_model=model)

    async def stream(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        timeout: float,
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator[str]:
        """Stream one chat completion, yielding incremental text as it arrives.

        The request is identical to :meth:`complete` — same credential, base URL,
        model and tool handling — save for ``stream: true``; the response is an
        SSE body whose ``data:`` frames each carry a ``choices[0].delta.content``
        fragment, yielded in order. OpenRouter keep-alive comment lines and the
        terminal ``data: [DONE]`` sentinel carry no text and are skipped.

        Raises :class:`LLMError` on a non-2xx status or a transport failure,
        mirroring :meth:`complete`; as there, the request headers (which carry the
        key) are never echoed into the message.
        """
        headers = {
            "Authorization": f"Bearer {self._resolve_api_key()}",
            "Content-Type": "application/json",
        }
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": True,
            "usage": {"include": True},
        }
        if tools:
            body["tools"] = tools
        try:
            async with self._http.stream(
                "POST",
                f"{self._base_url}/chat/completions",
                headers=headers,
                json=body,
                timeout=timeout,
            ) as response:
                if response.status_code >= 400:
                    # A streamed response's body is not read yet; pull it in full
                    # so the provider's message (not the key-bearing request) is
                    # what lands in the error.
                    detail = (await response.aread()).decode(errors="replace")
                    raise LLMError(f"OpenRouter returned {response.status_code}: {detail[:500]}")
                async for line in response.aiter_lines():
                    chunk = _parse_sse_delta(line)
                    if chunk:
                        yield chunk
        except httpx.HTTPError as exc:
            raise LLMError(f"OpenRouter request failed: {exc}") from exc


def _parse_sse_delta(line: str) -> str:
    """The incremental text carried by one SSE line, or ``""`` if it carries none.

    OpenRouter streams Server-Sent Events: ``data:`` frames holding a JSON chunk,
    ``: `` comment lines for keep-alive, blank separators, and a final
    ``data: [DONE]``. Only a frame with a string ``choices[0].delta.content``
    yields text; everything else (comments, blanks, the sentinel, tool-call-only
    deltas, malformed JSON) yields ``""`` and is skipped by the caller.
    """
    line = line.strip()
    if not line.startswith("data:"):
        return ""
    data = line[len("data:") :].strip()
    if not data or data == "[DONE]":
        return ""
    try:
        parsed = json.loads(data)
    except ValueError:
        return ""
    if not isinstance(parsed, dict):
        return ""
    choices = parsed.get("choices") or []
    if not choices:
        return ""
    delta = (choices[0] or {}).get("delta") or {}
    content = delta.get("content")
    return content if isinstance(content, str) else ""


def _parse_completion(data: Any, *, fallback_model: str) -> LLMResponse:
    if not isinstance(data, dict):
        raise LLMError("OpenRouter response was not a JSON object")
    choices = data.get("choices") or []
    if not choices:
        raise LLMError(f"OpenRouter returned no choices: {str(data)[:300]}")

    choice = choices[0] or {}
    message = choice.get("message") or {}
    usage = data.get("usage") or {}
    return LLMResponse(
        content=str(message.get("content") or ""),
        model=str(data.get("model") or fallback_model),
        finish_reason=str(choice.get("finish_reason") or "stop"),
        input_tokens=_as_int(usage.get("prompt_tokens")),
        output_tokens=_as_int(usage.get("completion_tokens")),
        cost_usd=_as_float(usage.get("cost")),
        tool_calls=_parse_tool_calls(message.get("tool_calls")),
        annotations=_parse_annotations(message.get("annotations")),
    )


def _parse_tool_calls(raw: Any) -> tuple[ToolCall, ...]:
    """Normalise the provider's ``tool_calls`` array.

    Anything malformed is skipped rather than raising: a call with no id can
    never be answered (a tool result is keyed to one), and failing the whole
    completion over one bad entry would throw away the turn's other work. What
    survives is bounded and typed; the arguments are still model-generated text
    and are re-checked against the tool's schema before execution (``tools.py``).
    """
    if not isinstance(raw, list):
        return ()
    calls: list[ToolCall] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        function = item.get("function")
        if not isinstance(function, dict):
            continue
        call_id = str(item.get("id") or "").strip()
        name = str(function.get("name") or "").strip()
        if not call_id or not name:
            continue
        arguments_json = function.get("arguments")
        arguments_json = arguments_json if isinstance(arguments_json, str) else "{}"
        try:
            parsed = json.loads(arguments_json or "{}")
        except ValueError:
            parsed = {}
        calls.append(
            ToolCall(
                id=call_id,
                name=name,
                arguments=parsed if isinstance(parsed, dict) else {},
                arguments_json=arguments_json or "{}",
            )
        )
    return tuple(calls)


def _parse_annotations(raw: Any) -> tuple[Annotation, ...]:
    """Normalise ``message.annotations`` — the citations an ``:online`` model call
    returns (fixture: a real OpenRouter ``:online`` completion, captured
    2026-08-12, in ``tests/fixtures/openrouter_online_completion.json``).

    Mirrors ``_parse_tool_calls``'s posture: a malformed entry is skipped, not
    fatal — the run's other evidence is still worth keeping over failing the
    whole completion for one bad citation. Only ``url_citation`` entries carry a
    usable ``url``/``title``; any other ``type`` (a future annotation kind this
    runtime does not yet know) or an entry missing a non-empty ``url`` is
    skipped rather than guessed at.
    """
    if not isinstance(raw, list):
        return ()
    annotations: list[Annotation] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("type") or "").strip()
        if kind != "url_citation":
            continue
        citation = item.get("url_citation")
        if not isinstance(citation, dict):
            continue
        url = str(citation.get("url") or "").strip()
        if not url:
            continue
        title = str(citation.get("title") or "").strip()
        annotations.append(Annotation(type=kind, url=url, title=title))
    return tuple(annotations)


def _as_int(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _as_float(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
