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
Secrets Manager using ``OPENROUTER_API_KEY_SECRET_ARN``. It is never committed,
never logged, and never included in an error: the exceptions raised below carry
the provider's status and body, both of which are provider output, and the key
only ever leaves this module inside an ``Authorization`` header.

The client is deliberately thin — no retries, no streaming, no tool schemas. Each
of those is a later milestone, and each attaches to the loop rather than to this
file: ``AgentLoop`` already yields per-turn events, so streaming becomes a
different consumer rather than a rewrite here.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"

# Env var names. The direct value wins so a local run or a test never reaches for
# AWS; the ARN is what Terraform wires in a real deployment.
_KEY_ENV = "OPENROUTER_API_KEY"  # noqa: S105 — an env var name, not a credential
_KEY_SECRET_ARN_ENV = "OPENROUTER_API_KEY_SECRET_ARN"  # noqa: S105 — likewise

# Keys tried when a Secrets Manager secret holds JSON rather than a bare string.
_SECRET_JSON_KEYS = ("api_key", "OPENROUTER_API_KEY", "key")


class LLMError(Exception):
    """The provider call failed. Terminal for the run (ADR-0014 §5)."""


@dataclass(frozen=True)
class LLMResponse:
    """One completion, normalised away from the provider's wire shape."""

    content: str
    model: str
    finish_reason: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None


class LLMClient(Protocol):
    """The slice of an LLM client :class:`~agent_runtime.loop.AgentLoop` uses.

    A Protocol rather than the concrete class so the loop is testable without a
    network and so a second provider is a new implementation, not a branch.
    """

    async def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        timeout: float,
    ) -> LLMResponse: ...


def _extract_secret_value(raw: str) -> str:
    """A Secrets Manager secret may be the bare key or a JSON object holding it."""
    import json

    stripped = raw.strip()
    if not stripped.startswith("{"):
        return stripped
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError as exc:
        raise LLMError(f"OpenRouter secret is neither a bare key nor valid JSON: {exc}") from exc
    for key in _SECRET_JSON_KEYS:
        value = data.get(key)
        if value:
            return str(value)
    raise LLMError(
        f"OpenRouter secret JSON has none of the expected keys {list(_SECRET_JSON_KEYS)}"
    )


class OpenRouterClient:
    """Async OpenRouter chat-completions client."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        http_client: httpx.AsyncClient | None = None,
        secrets_client: Any | None = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = (base_url or os.environ.get("OPENROUTER_BASE_URL") or "").rstrip(
            "/"
        ) or DEFAULT_BASE_URL
        self._http = http_client if http_client is not None else httpx.AsyncClient()
        self._secrets = secrets_client

    def _resolve_api_key(self) -> str:
        """The key, resolved once and cached for the life of the container.

        Env var first (local, tests), Secrets Manager second (deployed). Raises
        rather than proceeding unauthenticated — a 401 from the provider is a
        worse diagnostic than the missing-configuration message.
        """
        if self._api_key:
            return self._api_key

        env_key = os.environ.get(_KEY_ENV, "").strip()
        if env_key:
            self._api_key = env_key
            return env_key

        secret_arn = os.environ.get(_KEY_SECRET_ARN_ENV, "").strip()
        if not secret_arn:
            raise LLMError(f"No OpenRouter credential: set {_KEY_ENV} or {_KEY_SECRET_ARN_ENV}.")

        client = self._secrets
        if client is None:
            import boto3

            client = boto3.client("secretsmanager")
            self._secrets = client
        try:
            secret = client.get_secret_value(SecretId=secret_arn)
        except Exception as exc:  # noqa: BLE001 — botocore raises many shapes; all are fatal here
            raise LLMError(f"Could not read the OpenRouter secret: {exc}") from exc

        self._api_key = _extract_secret_value(str(secret.get("SecretString") or ""))
        return self._api_key

    async def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        timeout: float,
    ) -> LLMResponse:
        """One chat completion. Raises :class:`LLMError` for anything non-2xx."""
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
    )


def _as_int(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _as_float(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
