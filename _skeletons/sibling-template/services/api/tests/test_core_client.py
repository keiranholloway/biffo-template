"""tabsii-crm#137 — a proxied error must reach a caller as a plain message, not a
JSON string re-serialised from an already-JSON upstream body.

`CoreApiClient` raises `CoreApiError(status_code, detail)` on every verb, and
every router does `HTTPException(status_code=exc.status_code, detail=exc.detail)`.
Before this fix, `detail` was `response.text` — the WHOLE upstream body — so a
core error like `{"detail": "Method Not Allowed"}` became, once FastAPI
serialised it a second time, `{"detail": "{\\"detail\\": \\"Method Not
Allowed\\"}"}`: valid JSON, but a JSON *string* rather than the message inside
it. Any component that renders `detail` showed that raw escaped blob.
"""

from pathlib import Path

import httpx
import pytest

from api import core_client as core_client_module
from api.config import settings
from api.core_client import CoreApiClient, CoreApiError, _extract_detail


class TestExtractDetail:
    """Unit-level: the parsing rule alone, with no network involved."""

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


class TestIntegrityRefusalDetail:
    """tabsii-crm#272 — the same bug as tabsii-crm#137, one shape further in.

    Core's generic CRUD layer answers an integrity error with a **dict**
    `detail` (`{"message": ..., "constraint": ...}`), which the original
    string-only check rejected. So it fell through to `response.text` and
    rebuilt the exact defect this module was written to fix.

    It was not hypothetical. A delete refused because other records still
    depend on the row came back from the schema as a sentence written FOR THE
    USER, naming what depends on it and prescribing the remedy — and the user
    saw the escaped JSON blob wrapped around that sentence instead.
    """

    #: A real refusal of that shape, trimmed. The remedy clause is the
    #: load-bearing part — it is the only thing telling the user what to do
    #: instead, and it is exactly what the escaped blob buried.
    _REFUSAL = (
        "record 0c0de102 cannot be deleted: 3 dependent record(s) reference it. "
        "Set status to 'archived' instead — an archived record leaves the "
        "active list while every reference stays intact."
    )

    def test_a_dict_detail_is_unwrapped_to_its_message(self) -> None:
        response = httpx.Response(
            409, json={"detail": {"message": self._REFUSAL, "constraint": None}}
        )
        assert _extract_detail(response) == self._REFUSAL

    def test_the_raw_body_does_not_reach_the_caller(self) -> None:
        """The failure mode stated positively: no JSON punctuation, because a
        blob starting `{"detail":{"message":` is what the author actually saw."""
        response = httpx.Response(
            409, json={"detail": {"message": self._REFUSAL, "constraint": None}}
        )
        extracted = _extract_detail(response)
        assert not extracted.startswith("{")
        assert '"detail"' not in extracted

    def test_the_constraint_name_is_dropped_not_appended(self) -> None:
        """A constraint name is a database object name — schema reconnaissance
        (tabsii-platform#473), and meaningless to whoever reads the sentence."""
        response = httpx.Response(
            409,
            json={"detail": {"message": "That name is already taken.", "constraint": "uq_x_name"}},
        )
        assert _extract_detail(response) == "That name is already taken."

    def test_a_dict_detail_with_no_message_still_falls_back(self) -> None:
        """Only the declared key is trusted. Summarising a shape nobody has
        declared would hide information rather than surface it — the same
        principle as the non-JSON fallback above."""
        response = httpx.Response(500, json={"detail": {"code": "E17", "constraint": None}})
        assert _extract_detail(response) == response.text


class TestCoreApiClientErrorPassthrough:
    """End-to-end: a mocked upstream error reaches `CoreApiError.detail` flat."""

    async def test_get_surfaces_the_inner_message_not_the_whole_body(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={"detail": "Brand not found"})

        _install_mock_transport(monkeypatch, handler)

        client = CoreApiClient("a-token")
        with pytest.raises(CoreApiError) as exc_info:
            await client.get("/api/v1/brands/does-not-exist")

        assert exc_info.value.status_code == 404
        # The regression this guards: NOT '{"detail": "Brand not found"}'.
        assert exc_info.value.detail == "Brand not found"

    async def test_post_surfaces_the_inner_message_not_the_whole_body(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(405, json={"detail": "Method Not Allowed"})

        _install_mock_transport(monkeypatch, handler)

        client = CoreApiClient("a-token")
        with pytest.raises(CoreApiError) as exc_info:
            await client.post("/api/v1/fdds", {})

        assert exc_info.value.status_code == 405
        assert exc_info.value.detail == "Method Not Allowed"


def _install_mock_transport(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    """Make `CoreApiClient`'s internal `httpx.AsyncClient(...)` use a
    `MockTransport` instead of a real connection, while leaving every other
    constructor argument (`base_url`, `timeout`) exactly as production passes
    them.

    `settings.core_api_url` also needs a real-looking base URL here: it
    defaults to `""` outside a deployed environment, and httpx's cookie
    handling chokes on a scheme-less, host-less request URL before the mock
    transport is ever reached.
    """
    monkeypatch.setattr(settings, "core_api_url", "https://core.example.test")

    real_async_client = httpx.AsyncClient

    def fake_async_client(*args: object, **kwargs: object) -> httpx.AsyncClient:
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr("api.core_client.httpx.AsyncClient", fake_async_client)


class TestTimeoutHandling:
    """tabsii-crm#221 — a cold core must not surface as "Internal Server Error".

    The reported failure: a landing page rendered *"Signed in, but could
    not reach the API: Internal Server Error"* whenever core had gone cold. The
    BFF's hardcoded 10s budget was shorter than core's ~7.8s cold start plus the
    work itself, so `httpx.ReadTimeout` escaped as an unhandled exception.
    """

    async def test_a_timeout_becomes_a_504_with_an_explained_message(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Not a 500, and not the raw exception.

        A 504 is what actually happened — an upstream did not answer — and the
        detail tells the reader the one thing they can act on. The old behaviour
        told them the platform was broken when it was merely asleep.
        """

        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("core is cold", request=request)

        _install_mock_transport(monkeypatch, handler)

        client = CoreApiClient("a-token")
        with pytest.raises(CoreApiError) as exc_info:
            await client.get("/api/v1/whoami")

        assert exc_info.value.status_code == 504
        assert "try again" in exc_info.value.detail.lower()
        assert "internal server error" not in exc_info.value.detail.lower()

    async def test_a_get_is_retried_once_and_a_warm_second_attempt_succeeds(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The actual repair for the reported bug.

        The user's own workaround was to reload the page, which worked because
        the second request found the Lambda warm. This does that for them.
        """
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.method)
            if len(calls) == 1:
                raise httpx.ReadTimeout("core is cold", request=request)
            return httpx.Response(200, json={"ok": True})

        _install_mock_transport(monkeypatch, handler)

        assert await CoreApiClient("a-token").get("/api/v1/whoami") == {"ok": True}
        assert calls == ["GET", "GET"], "the first attempt must be retried exactly once"

    async def test_a_post_is_never_retried_after_a_read_timeout(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """**The data-integrity half, and the reason `_may_retry` exists.**

        A `ReadTimeout` means the request reached core and the answer was lost —
        core may have processed it. Re-sending a POST in that state creates the
        row twice and the caller sees a single success. So a write times out
        once and stops.

        If a later change makes this fail, the fix is never "retry everything":
        it is to give the write an idempotency key so a retry can be recognised.
        """
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.method)
            raise httpx.ReadTimeout("core is cold", request=request)

        _install_mock_transport(monkeypatch, handler)

        with pytest.raises(CoreApiError) as exc_info:
            await CoreApiClient("a-token").post("/api/v1/leads", {"name": "x"})

        assert exc_info.value.status_code == 504
        assert calls == ["POST"], "a write must NOT be re-sent — it may have been applied"

    async def test_a_post_is_retried_after_a_connect_timeout(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The distinction the test above depends on.

        A `ConnectTimeout` never established a connection, so core provably did
        not see the request and re-sending cannot duplicate anything. Without
        this case the previous test would pass just as well against a client that
        never retried writes for the *wrong* reason.
        """
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.method)
            if len(calls) == 1:
                raise httpx.ConnectTimeout("no connection", request=request)
            return httpx.Response(200, json={"created": True})

        _install_mock_transport(monkeypatch, handler)

        assert await CoreApiClient("a-token").post("/api/v1/leads", {"n": 1}) == {"created": True}
        assert calls == ["POST", "POST"]

    async def test_the_retry_budget_fits_inside_the_gateway_ceiling(self) -> None:
        """The arithmetic, asserted rather than left in a comment.

        The HTTP API integration times out at 29s. Two attempts at the configured
        timeout must finish inside that, or the gateway answers first and the
        caller gets a bare 504 with none of the explanation above. Someone raising
        the timeout to "be safe" would silently reintroduce the original bug in a
        new form; this stops them.
        """
        gateway_ceiling_seconds = 29
        assert settings.core_api_timeout_seconds * 2 < gateway_ceiling_seconds

    async def test_every_verb_shares_one_timeout(self) -> None:
        """The duplication that let the value go stale is gone.

        The timeout was copied into all five methods, so it stayed at 10 while
        core's cold start grew past it. Any reappearance of a literal here means
        the next person has five places to update again.
        """
        source = Path(core_client_module.__file__).read_text()
        code = "\n".join(line for line in source.splitlines() if not line.strip().startswith("#"))
        body = code.split('"""', 2)[-1]  # drop the module docstring
        assert "timeout=10" not in body
        assert body.count("settings.core_api_timeout_seconds") == 1
