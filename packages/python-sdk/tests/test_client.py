"""Tests for BiffoAPIClient and BiffoAPIError.

All HTTP traffic is intercepted with ``httpx.MockTransport`` — no test in
this module makes a real network call.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from biffo_plugin_sdk import BiffoAPIClient, BiffoAPIError


def make_client(
    handler: Any,
    base_url: str = "https://api.example.com",
    token: str | None = "test-jwt",
) -> BiffoAPIClient:
    transport = httpx.MockTransport(handler)
    async_client = httpx.AsyncClient(transport=transport)
    return BiffoAPIClient(base_url=base_url, token=token, client=async_client)


# --- __init__ / env var handling ---


class TestInit:
    def test_reads_base_url_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("BIFFO_CORE_API_URL", "https://core.biffo.dev")

        client = BiffoAPIClient()

        assert client.base_url == "https://core.biffo.dev"

    def test_ignores_biffo_jwt_token_env_var(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """``BIFFO_JWT_TOKEN`` is no longer read — nothing ever issued it.

        The env fallback made the default client look authenticated while
        sending ``{}`` for ``Authorization`` (ADR-0009 / issue #197). SigV4 via
        ``create_core_client`` is the machine-caller path now; ``token=`` stays
        an explicit constructor argument only.
        """
        monkeypatch.setenv("BIFFO_JWT_TOKEN", "env-token")

        client = BiffoAPIClient(base_url="https://core.biffo.dev")

        assert client.token is None
        assert client._auth_headers() == {}

    def test_missing_env_vars_handled_gracefully(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("BIFFO_CORE_API_URL", raising=False)

        client = BiffoAPIClient()

        assert client.base_url == ""
        assert client.token is None

    def test_explicit_args_override_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("BIFFO_CORE_API_URL", "https://core.biffo.dev")

        client = BiffoAPIClient(base_url="https://override.example.com", token="override-token")

        assert client.base_url == "https://override.example.com"
        assert client.token == "override-token"

    def test_trailing_slash_stripped_from_base_url(self) -> None:
        client = BiffoAPIClient(base_url="https://api.example.com/", token=None)

        assert client.base_url == "https://api.example.com"


# --- _auth_headers ---


class TestAuthHeaders:
    def test_injects_bearer_token_when_present(self) -> None:
        client = BiffoAPIClient(base_url="https://api.example.com", token="abc123")

        assert client._auth_headers() == {"Authorization": "Bearer abc123"}

    def test_empty_when_no_token(self) -> None:
        client = BiffoAPIClient(base_url="https://api.example.com", token=None)

        assert client._auth_headers() == {}


# --- _raise_if_error ---


class TestRaiseIfError:
    @pytest.mark.parametrize("status_code", [200, 201, 204])
    def test_no_error_for_2xx(self, status_code: int) -> None:
        response = httpx.Response(
            status_code, json={"ok": True}, request=httpx.Request("GET", "https://x")
        )

        BiffoAPIClient._raise_if_error(response)  # must not raise

    @pytest.mark.parametrize("status_code", [400, 401, 403, 404, 422, 500, 503])
    def test_raises_for_4xx_and_5xx(self, status_code: int) -> None:
        response = httpx.Response(
            status_code,
            json={"detail": "something went wrong"},
            request=httpx.Request("GET", "https://x"),
        )

        with pytest.raises(BiffoAPIError) as exc_info:
            BiffoAPIClient._raise_if_error(response)

        assert exc_info.value.status_code == status_code
        assert exc_info.value.detail == "something went wrong"

    def test_non_json_error_body_falls_back_to_text(self) -> None:
        response = httpx.Response(
            500, text="internal server error", request=httpx.Request("GET", "https://x")
        )

        with pytest.raises(BiffoAPIError) as exc_info:
            BiffoAPIClient._raise_if_error(response)

        assert exc_info.value.status_code == 500
        assert "internal server error" in exc_info.value.detail

    def test_error_without_body_falls_back_to_reason_phrase(self) -> None:
        response = httpx.Response(404, request=httpx.Request("GET", "https://x"))

        with pytest.raises(BiffoAPIError) as exc_info:
            BiffoAPIClient._raise_if_error(response)

        assert exc_info.value.status_code == 404


# --- get/post/put/delete ---


class TestGet:
    async def test_success_returns_json(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.method == "GET"
            assert request.url.path == "/plugins/rbac/roles"
            assert request.headers["Authorization"] == "Bearer test-jwt"
            assert request.headers["Content-Type"] == "application/json"
            return httpx.Response(200, json={"roles": ["admin"]})

        client = make_client(handler)

        result = await client.get("/plugins/rbac/roles")

        assert result == {"roles": ["admin"]}

    async def test_passes_query_params(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.params["active"] == "true"
            return httpx.Response(200, json=[])

        client = make_client(handler)

        await client.get("/plugins/rbac/roles", params={"active": "true"})

    async def test_error_response_raises(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={"detail": "Not found"})

        client = make_client(handler)

        with pytest.raises(BiffoAPIError) as exc_info:
            await client.get("/plugins/rbac/roles/missing")

        assert exc_info.value.status_code == 404

    async def test_no_auth_header_when_token_missing(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert "Authorization" not in request.headers
            return httpx.Response(200, json={})

        client = make_client(handler, token=None)

        await client.get("/plugins/rbac/roles")


class TestPost:
    async def test_sends_json_body(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.method == "POST"
            assert request.content == b'{"slug":"admin"}'
            return httpx.Response(201, json={"id": "1", "slug": "admin"})

        client = make_client(handler)

        result = await client.post("/plugins/rbac/roles", json={"slug": "admin"})

        assert result == {"id": "1", "slug": "admin"}

    async def test_error_response_raises(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(422, json={"detail": "Invalid payload"})

        client = make_client(handler)

        with pytest.raises(BiffoAPIError):
            await client.post("/plugins/rbac/roles", json={})


class TestPut:
    async def test_sends_json_body(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.method == "PUT"
            assert request.content == b'{"slug":"superadmin"}'
            return httpx.Response(200, json={"id": "1", "slug": "superadmin"})

        client = make_client(handler)

        result = await client.put("/plugins/rbac/roles/1", json={"slug": "superadmin"})

        assert result == {"id": "1", "slug": "superadmin"}

    async def test_error_response_raises(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"detail": "Server error"})

        client = make_client(handler)

        with pytest.raises(BiffoAPIError):
            await client.put("/plugins/rbac/roles/1", json={})


class TestDelete:
    async def test_success_with_empty_body_returns_none(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.method == "DELETE"
            assert request.headers["Authorization"] == "Bearer test-jwt"
            return httpx.Response(204)

        client = make_client(handler)

        result = await client.delete("/plugins/rbac/roles/1")

        assert result is None

    async def test_error_response_raises(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(403, json={"detail": "Forbidden"})

        client = make_client(handler)

        with pytest.raises(BiffoAPIError) as exc_info:
            await client.delete("/plugins/rbac/roles/1")

        assert exc_info.value.status_code == 403


# --- context manager / close ---


class TestLifecycle:
    async def test_used_as_async_context_manager(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"ok": True})

        transport = httpx.MockTransport(handler)
        async_client = httpx.AsyncClient(transport=transport)

        async with BiffoAPIClient(
            base_url="https://api.example.com", token="t", client=async_client
        ) as client:
            result = await client.get("/health")

        assert result == {"ok": True}
        assert async_client.is_closed
