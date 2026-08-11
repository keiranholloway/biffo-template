"""Tests for ``PrincipalCoreClient`` — the consolidated dual-auth pattern

(SigV4 signature + the calling user's own forwarded token) from issue #1490.

Three independent implementations of this mechanism existed before this class:
the shared plugin host's ``core_sender`` (correct — used ``raw_request``'s
``extra_signed_headers``, added before signing), and two hand-rolled
``CoreTransport`` subclasses (idea-scout, ideation) that added the forwarded
token to the headers dict ``_sign()`` *returned* — i.e. after signing, so it
rode along unsigned. The tests below specifically assert the header is
*covered by the SigV4 signature*, not merely present on the wire, because a
test that only checked "the header string is there" would have passed against
the broken shape too.
"""

from __future__ import annotations

import httpx
import pytest
from biffo_plugin_sdk import FORWARDED_USER_HEADER, BiffoAPIError, PrincipalCoreClient
from botocore.credentials import Credentials

_CREDS = Credentials("AKIDTEST", "SECRETTEST")


def _client(handler, *, user_token: str = "founder-jwt") -> PrincipalCoreClient:
    transport = httpx.MockTransport(handler)
    return PrincipalCoreClient(
        user_token,
        base_url="https://core.example.com",
        region="eu-west-1",
        credentials=_CREDS,
        client=httpx.AsyncClient(transport=transport),
    )


async def test_forwarded_token_is_signed_not_merely_appended():
    """The decisive assertion: the header name must appear in SigV4's own
    SignedHeaders list, proving it was folded in BEFORE ``SigV4Auth.add_auth``
    ran — not appended to the headers dict afterward, which is exactly the bug
    both hand-rolled ``CoreTransport`` copies had. A test asserting only
    ``request.headers.get(FORWARDED_USER_HEADER) == "founder-jwt"`` would pass
    against that broken shape too, since httpx still sends an unsigned header
    perfectly well; asserting it is present is a necessary but not sufficient
    condition, and this test deliberately checks the sufficient one.
    """
    captured: dict[str, object] = {}

    def handle(request: httpx.Request) -> httpx.Response:
        captured["token"] = request.headers.get(FORWARDED_USER_HEADER)
        captured["auth"] = request.headers.get("Authorization", "")
        return httpx.Response(200, json={"ok": True})

    client = _client(handle, user_token="founder-jwt")
    result = await client.post("/api/v1/internal/plugins/marketing/campaigns", json={"a": 1})

    assert result == {"ok": True}
    assert captured["token"] == "founder-jwt"
    auth = str(captured["auth"])
    assert auth.startswith("AWS4-HMAC-SHA256")
    assert "SignedHeaders=" in auth
    # The decisive check: the forwarded-token header's name is in the signed set.
    assert "x-biffo-user-token" in auth.lower()


async def test_raw_request_also_signs_the_forwarded_token():
    """``raw_request`` (the proxying path the plugin host's ``core_sender``
    uses) goes through the same overridden ``_sign``, so it must carry the
    same guarantee — this is the exact call shape ``app.py::core_sender``
    already used manually via ``extra_signed_headers``; this class makes that
    automatic and not re-derivable-wrong per call site.
    """
    captured: dict[str, object] = {}

    def handle(request: httpx.Request) -> httpx.Response:
        captured["token"] = request.headers.get(FORWARDED_USER_HEADER)
        captured["auth"] = request.headers.get("Authorization", "")
        return httpx.Response(200, json={"ok": True})

    client = _client(handle, user_token="admin-jwt")
    status, body, content_type = await client.raw_request(
        "GET", "/api/v1/internal/plugins/idea-scout/ideas"
    )

    assert status == 200
    assert content_type.startswith("application/json")
    assert captured["token"] == "admin-jwt"
    assert "x-biffo-user-token" in str(captured["auth"]).lower()


async def test_patch_is_supported_and_signed():
    """PATCH is the verb the two owner-data transports needed and the base
    ``SignedCoreClient`` lacked before this consolidation — a real gap, not
    invented for this issue.
    """
    captured: dict[str, object] = {}

    def handle(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["token"] = request.headers.get(FORWARDED_USER_HEADER)
        captured["auth"] = request.headers.get("Authorization", "")
        return httpx.Response(200, json={"patched": True})

    client = _client(handle, user_token="founder-jwt")
    result = await client.patch(
        "/api/v1/internal/plugins/ideation/sessions/1", json={"status": "done"}
    )

    assert result == {"patched": True}
    assert captured["method"] == "PATCH"
    assert captured["token"] == "founder-jwt"
    assert "x-biffo-user-token" in str(captured["auth"]).lower()


async def test_plugin_identity_and_forwarded_token_are_both_signed_together():
    """The two dual-auth headers (ADR-0021's plugin identity and #1490's
    forwarded user token) must coexist and both land inside the same
    signature when a request goes through the shared plugin host acting as a
    named plugin.
    """
    from biffo_plugin_sdk import PLUGIN_IDENTITY_HEADER, acting_as_plugin

    captured: dict[str, object] = {}

    def handle(request: httpx.Request) -> httpx.Response:
        captured["plugin"] = request.headers.get(PLUGIN_IDENTITY_HEADER)
        captured["token"] = request.headers.get(FORWARDED_USER_HEADER)
        captured["auth"] = request.headers.get("Authorization", "")
        return httpx.Response(200, json={})

    client = _client(handle, user_token="founder-jwt")
    reset_token = acting_as_plugin.set("marketing")
    try:
        await client.post("/api/v1/internal/plugins/marketing/campaigns", json={})
    finally:
        acting_as_plugin.reset(reset_token)

    assert captured["plugin"] == "marketing"
    assert captured["token"] == "founder-jwt"
    signed = str(captured["auth"]).lower()
    assert "x-biffo-plugin" in signed
    assert "x-biffo-user-token" in signed


async def test_error_response_still_raises_biffo_api_error():
    """Reuses ``SignedCoreClient``'s error mapping unchanged — a non-2xx from
    Core's ``require_principal_crud_permission`` guard must surface as
    ``BiffoAPIError``, same as any other signed call.
    """

    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"detail": "Not authorized for this record"})

    client = _client(handle)
    with pytest.raises(BiffoAPIError) as exc:
        await client.get("/api/v1/internal/plugins/marketing/campaigns")

    assert exc.value.status_code == 403


async def test_without_the_fix_the_header_would_be_unsigned():
    """Demonstrates the actual defect being consolidated away: calling the
    base ``SignedCoreClient._sign`` directly and adding the forwarded header
    to its RETURN VALUE (exactly what both hand-rolled ``CoreTransport``
    copies did) produces a header that is present but NOT in SignedHeaders —
    i.e. this test fails the decisive assertion from
    ``test_forwarded_token_is_signed_not_merely_appended`` if the fix is
    reverted to that shape, proving the earlier test is actually exercising
    signature coverage and not just header presence.
    """
    from biffo_plugin_sdk import SignedCoreClient

    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={}))
    broken = SignedCoreClient(
        base_url="https://core.example.com",
        region="eu-west-1",
        credentials=_CREDS,
        client=httpx.AsyncClient(transport=transport),
    )

    url = broken._url("/api/v1/internal/plugins/idea-scout/ideas")
    headers = broken._sign("GET", url, None)  # the base signer, no forwarded token yet
    headers[FORWARDED_USER_HEADER] = "founder-jwt"  # bolted on AFTER signing (the old bug)

    assert headers[FORWARDED_USER_HEADER] == "founder-jwt"  # present...
    assert "x-biffo-user-token" not in headers["Authorization"].lower()  # ...but not signed
