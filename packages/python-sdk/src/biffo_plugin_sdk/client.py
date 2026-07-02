"""Typed async HTTP client plugins use to talk to the Core API.

``BiffoAPIClient`` centralises the two things every plugin otherwise has to
reinvent: reading the Core API's base URL and the plugin's JWT from the
environment (set by the CLI during ``biffo plugin install``, see
``docs/ADR/0003``), and turning non-2xx responses into a single exception
type (``BiffoAPIError``) instead of leaking ``httpx`` internals into plugin
code.

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
    """Async HTTP client for plugins to call the Core API.

    By default the base URL and JWT come from the ``BIFFO_CORE_API_URL`` and
    ``BIFFO_JWT_TOKEN`` environment variables, which the CLI sets during
    ``biffo plugin install``. They can also be passed explicitly, which is
    mainly useful for tests.
    """

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        timeout: float = 30.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        resolved_base_url = (
            base_url
            if base_url is not None
            else os.environ.get("BIFFO_CORE_API_URL", "")
        )
        self.base_url = resolved_base_url.rstrip("/")
        self.token = token if token is not None else os.environ.get("BIFFO_JWT_TOKEN")
        self._client = (
            client if client is not None else httpx.AsyncClient(timeout=timeout)
        )

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
        response = await self._client.get(
            self._url(path), headers=self._headers(), params=params
        )
        self._raise_if_error(response)
        return self._parse_json(response)

    async def post(self, path: str, json: dict[str, Any] | None = None) -> Any:
        """Issue an authenticated POST request and return the parsed JSON body."""
        response = await self._client.post(
            self._url(path), headers=self._headers(), json=json
        )
        self._raise_if_error(response)
        return self._parse_json(response)

    async def put(self, path: str, json: dict[str, Any] | None = None) -> Any:
        """Issue an authenticated PUT request and return the parsed JSON body."""
        response = await self._client.put(
            self._url(path), headers=self._headers(), json=json
        )
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
