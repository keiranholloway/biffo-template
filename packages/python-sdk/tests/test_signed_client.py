"""Tests for the SigV4-signing Core API client and client factory (ADR-0009)."""

from __future__ import annotations

import httpx
import pytest
from botocore.credentials import Credentials

from biffo_plugin_sdk import (
    BiffoAPIClient,
    BiffoPluginBase,
    PluginManifest,
    SignedCoreClient,
    create_core_client,
)

_CREDS = Credentials("AKIDTEST", "SECRETTEST")


def _client(handler) -> SignedCoreClient:
    transport = httpx.MockTransport(handler)
    return SignedCoreClient(
        base_url="https://core.example.com",
        region="eu-west-1",
        credentials=_CREDS,
        client=httpx.AsyncClient(transport=transport),
    )


async def test_post_is_sigv4_signed():
    captured: dict[str, object] = {}

    def handle(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("Authorization")
        captured["date"] = request.headers.get("X-Amz-Date")
        captured["body"] = request.content
        return httpx.Response(200, json={"runs": []})

    client = _client(handle)
    result = await client.post("/api/v1/internal/orchestration/events", json={"a": 1})

    assert result == {"runs": []}
    auth = captured["auth"]
    assert isinstance(auth, str)
    assert auth.startswith("AWS4-HMAC-SHA256")
    assert "Credential=AKIDTEST/" in auth
    assert "SignedHeaders=" in auth
    assert captured["date"]
    # The body signed must be exactly what is sent.
    assert captured["body"] == b'{"a": 1}'


async def test_get_includes_params_in_signed_url():
    seen: dict[str, str] = {}

    def handle(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("Authorization", "")
        return httpx.Response(200, json=[])

    client = _client(handle)
    await client.get(
        "/api/v1/internal/orchestration/triggers",
        params={"source": "biffo.core", "detail_type": "demo.requested"},
    )

    assert "source=biffo.core" in seen["url"]
    assert "detail_type=demo.requested" in seen["url"]
    assert seen["auth"].startswith("AWS4-HMAC-SHA256")


async def test_error_response_raises():
    from biffo_plugin_sdk import BiffoAPIError

    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"detail": "Service principal not authorized"})

    client = _client(handle)
    with pytest.raises(BiffoAPIError) as exc:
        await client.post("/api/v1/internal/orchestration/events", json={})

    assert exc.value.status_code == 403


class TestCreateCoreClient:
    """The SDK's default Core client must sign (ADR-0009), not silently no-op."""

    def test_defaults_to_sigv4_when_unset(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.delenv("BIFFO_CORE_AUTH_MODE", raising=False)

        client = create_core_client(base_url="https://core.example.com")

        assert isinstance(client, SignedCoreClient)

    def test_explicit_sigv4(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("BIFFO_CORE_AUTH_MODE", "SigV4")

        assert isinstance(create_core_client(), SignedCoreClient)

    def test_none_mode_returns_plain_client(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("BIFFO_CORE_AUTH_MODE", "none")

        client = create_core_client(base_url="https://core.example.com")

        assert isinstance(client, BiffoAPIClient)
        assert not isinstance(client, SignedCoreClient)

    def test_invalid_mode_is_rejected_not_guessed(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("BIFFO_CORE_AUTH_MODE", "bearer")

        with pytest.raises(ValueError, match="BIFFO_CORE_AUTH_MODE"):
            create_core_client()

    def test_plugin_base_default_api_signs(self, monkeypatch: pytest.MonkeyPatch):
        """A plugin author who does nothing gets an authenticated client."""
        monkeypatch.delenv("BIFFO_CORE_AUTH_MODE", raising=False)
        manifest = PluginManifest(
            name="example", version="0.1.0", description="d", author="a"
        )

        class _Plugin(BiffoPluginBase):
            def on_install(self) -> None: ...
            def on_uninstall(self) -> None: ...

        plugin = _Plugin(manifest)

        assert isinstance(plugin.api, SignedCoreClient)
