"""Typed async HTTP client plugins use to talk to the Core API.

``BiffoAPIClient`` centralises the two things every plugin otherwise has to
reinvent: reading the Core API's base URL from the environment
(``BIFFO_CORE_API_URL``, injected by ``modules/plugins/_template``), and turning
non-2xx responses into a single exception type (``BiffoAPIError``) instead of
leaking ``httpx`` internals into plugin code.

**This class does not authenticate.** It is the plain transport. The
plugin->Core auth mechanism is IAM SigV4 (ADR-0009), implemented by
:class:`~biffo_plugin_sdk.signed_client.SignedCoreClient`, which subclasses this
one — and it is what :func:`~biffo_plugin_sdk.signed_client.create_core_client`
(and therefore ``BiffoPluginBase.api``) builds by default. Use
``BiffoAPIClient`` directly only for an unprotected endpoint or in tests.

Historically this class read a ``BIFFO_JWT_TOKEN`` environment variable and
claimed the CLI set it during ``biffo plugin install``. Nothing ever set it — not
Terraform, not CI, not the CLI — so the documented default silently produced
unauthenticated calls against a protected API. The env fallback was removed in
favour of SigV4; ``token=`` remains for the narrow case of calling a
*user-facing*, Cognito-protected route with a JWT the caller already holds.

This module deliberately has no retry logic — that is a later chunk, per
issue #15's notes.
"""

from __future__ import annotations

import os
from typing import Any

import httpx


class BiffoAPIError(Exception):
    """Raised when the Core API responds with a 4xx or 5xx status code."""

    def __init__(self, status_code: int, detail: str, body: Any = None) -> None:
        self.status_code = status_code
        self.detail = detail
        self.body = body
        super().__init__(f"Biffo API error {status_code}: {detail}")


class BiffoAPIClient:
    """Async HTTP client for plugins to call the Core API — no authentication.

    The base URL defaults to the ``BIFFO_CORE_API_URL`` environment variable,
    which ``modules/plugins/_template`` injects into the plugin's Lambda. It can
    also be passed explicitly, which is mainly useful for tests.

    ``token`` is **not** read from the environment. Pass it explicitly to attach
    a ``Bearer`` header when calling a Cognito-protected user-facing route on
    behalf of a user. For the internal machine-to-machine path
    (``/api/v1/internal/*``) use ``SignedCoreClient`` / ``create_core_client``
    instead — see ADR-0009.
    """

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        timeout: float = 30.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        resolved_base_url = (
            base_url if base_url is not None else os.environ.get("BIFFO_CORE_API_URL", "")
        )
        self.base_url = resolved_base_url.rstrip("/")
        self.token = token
        self._client = client if client is not None else httpx.AsyncClient(timeout=timeout)

    def _auth_headers(self) -> dict[str, str]:
        """Return an ``Authorization`` header when a JWT token is available."""
        if self.token:
            return {"Authorization": f"Bearer {self.token}"}
        return {}

    def _headers(self) -> dict[str, str]:
        return {"Content-Type": "application/json", **self._auth_headers()}

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path if path.startswith('/') else f'/{path}'}"

    @staticmethod
    def _raise_if_error(response: httpx.Response) -> None:
        """Raise ``BiffoAPIError`` for 4xx/5xx responses; no-op for 2xx."""
        if response.is_success:
            return

        body: Any
        try:
            body = response.json()
        except ValueError:
            body = response.text

        detail = body.get("detail") if isinstance(body, dict) else None
        if not detail:
            detail = body if isinstance(body, str) and body else response.reason_phrase

        raise BiffoAPIError(response.status_code, str(detail), body)

    @staticmethod
    def _parse_json(response: httpx.Response) -> Any:
        """Parse a response body as JSON, returning ``None`` for empty bodies."""
        if not response.content:
            return None
        return response.json()

    async def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        """Issue an authenticated GET request and return the parsed JSON body."""
        response = await self._client.get(self._url(path), headers=self._headers(), params=params)
        self._raise_if_error(response)
        return self._parse_json(response)

    async def post(self, path: str, json: dict[str, Any] | None = None) -> Any:
        """Issue an authenticated POST request and return the parsed JSON body."""
        response = await self._client.post(self._url(path), headers=self._headers(), json=json)
        self._raise_if_error(response)
        return self._parse_json(response)

    async def put(self, path: str, json: dict[str, Any] | None = None) -> Any:
        """Issue an authenticated PUT request and return the parsed JSON body."""
        response = await self._client.put(self._url(path), headers=self._headers(), json=json)
        self._raise_if_error(response)
        return self._parse_json(response)

    async def patch(self, path: str, json: dict[str, Any] | None = None) -> Any:
        """Issue an authenticated PATCH request and return the parsed JSON body."""
        response = await self._client.patch(self._url(path), headers=self._headers(), json=json)
        self._raise_if_error(response)
        return self._parse_json(response)

    async def delete(self, path: str) -> Any:
        """Issue an authenticated DELETE request and return the parsed JSON body."""
        response = await self._client.delete(self._url(path), headers=self._headers())
        self._raise_if_error(response)
        return self._parse_json(response)

    async def aclose(self) -> None:
        """Close the underlying ``httpx.AsyncClient``."""
        await self._client.aclose()

    async def __aenter__(self) -> BiffoAPIClient:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()
