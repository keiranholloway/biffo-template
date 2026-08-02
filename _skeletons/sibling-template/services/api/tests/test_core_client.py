"""A proxied error must reach a caller as a plain message, not a JSON string
re-serialised from an already-JSON upstream body.

`CoreApiClient` raises `CoreApiError(status_code, detail)` on every verb, and a
router turns that into `HTTPException(status_code=exc.status_code,
detail=exc.detail)`. When `detail` was `response.text` — the WHOLE upstream
body — a core error like `{"detail": "Method Not Allowed"}` became, once
FastAPI serialised it a second time, `{"detail": "{\\"detail\\": \\"Method Not
Allowed\\"}"}`: valid JSON, but a JSON *string* rather than the message inside
it. Any component that renders `detail` showed that raw escaped blob to a user.

Found and fixed independently in two siblings (tabsii-crm#137, tabsii-lms#13)
before it was ever fixed in this skeleton, so three more siblings were still
shipping the bug months later. The test lives here now so a sibling is born
with it.
"""

import httpx
import pytest

from api.config import settings
from api.core_client import CoreApiClient, CoreApiError, _extract_detail


class TestExtractDetail:
    """The parsing rule alone, with no network involved."""

    def test_unwraps_a_json_detail_body(self) -> None:
        response = httpx.Response(422, json={"detail": "Method Not Allowed"})
        assert _extract_detail(response) == "Method Not Allowed"

    def test_falls_back_to_raw_text_when_not_json(self) -> None:
        response = httpx.Response(502, content=b"<html>Bad Gateway</html>")
        assert _extract_detail(response) == "<html>Bad Gateway</html>"

    def test_falls_back_to_raw_text_when_json_has_no_detail_key(self) -> None:
        response = httpx.Response(400, json={"message": "nope"})
        assert _extract_detail(response) == response.text

    def test_falls_back_to_raw_text_when_detail_is_not_a_string(self) -> None:
        # A validation-error body shaped like FastAPI's own 422 (`detail` is a
        # list of field errors) — extracting a non-string would just move the
        # double-encoding problem rather than fix it, so this is left as the
        # raw body precisely like the "not JSON" case.
        response = httpx.Response(422, json={"detail": [{"loc": ["body", "x"], "msg": "bad"}]})
        assert _extract_detail(response) == response.text


class TestCoreApiClientErrorPassthrough:
    """A mocked upstream error reaches `CoreApiError.detail` flat."""

    async def test_get_surfaces_the_inner_message_not_the_whole_body(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "core_api_url", "https://core.example.com")

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(403, json={"detail": "Administrator access required"})

        transport = httpx.MockTransport(handler)
        original = httpx.AsyncClient

        def patched(*args, **kwargs):  # type: ignore[no-untyped-def]
            kwargs["transport"] = transport
            return original(*args, **kwargs)

        monkeypatch.setattr(httpx, "AsyncClient", patched)

        with pytest.raises(CoreApiError) as excinfo:
            await CoreApiClient("token").get("/api/v1/admin/users")

        assert excinfo.value.detail == "Administrator access required"
        assert excinfo.value.status_code == 403
