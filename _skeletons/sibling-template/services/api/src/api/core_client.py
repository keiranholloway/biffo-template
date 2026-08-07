"""The only route from this sibling to the core project's API (ADR-0002/0007).

## The timeout budget, and why it is not a free choice (tabsii-crm#221)

Every call here runs inside a Lambda behind an HTTP API whose **integration
timeout is 29s** (`aws apigatewayv2 get-integrations` — the Lambda itself is
configured for 30s, so the gateway is the binding constraint). Anything this
client waits for is spent from that 29s. Exceed it and the caller gets a
gateway 504 with no message at all, which is strictly worse than a slow answer.

So the numbers below are derived, not picked:

    first attempt   CORE_API_TIMEOUT_SECONDS   12s
    one retry       CORE_API_TIMEOUT_SECONDS   12s
                                             ----
    worst case                                24s   <  29s gateway ceiling

The previous value was a hardcoded `timeout=10`, copied into every call site.
Against core's measured **~7.8s cold start** (tabsii-platform#567) that left
roughly two seconds for the actual work, and a cold core produced
`httpx.ReadTimeout` -> an unhandled exception -> a 500 Internal Server Error on
whichever surface a session happened to hit first. Reloading fixed it, because
the second request found the Lambda warm — which is precisely what the retry
now does automatically.

Worth knowing which way the risk runs in a quiet app: a surface hit *less*
often than a busy landing page makes a cold core **more** likely, not less.
"""

import httpx
from fastapi import HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import settings

_security = HTTPBearer()

#: What a caller is told when core does not answer in time. A timeout is a
#: transient condition with an obvious user action, so it says so — unlike the
#: bare "Internal Server Error" this replaces, which described the symptom to
#: the one person who could do nothing about it.
_TIMEOUT_DETAIL = (
    "The service took too long to respond. This usually clears on a retry — "
    "please try again in a moment."
)


def _may_retry(method: str, exc: httpx.TimeoutException) -> bool:
    """Whether re-sending ``method`` after ``exc`` is safe.

    **This is a correctness question, not a tuning one.** A blanket retry would
    be a data-integrity bug: `ReadTimeout` means the request *was* delivered and
    we simply never saw the answer, so core may well have processed it. Re-sending
    a POST in that state creates the row twice, and the user sees one success.

    * ``ConnectTimeout`` — the connection was never established, so core cannot
      have seen the request. Safe for **any** verb.
    * ``ReadTimeout`` and everything else — sent, outcome unknown. Safe only for
      ``GET``, which changes nothing by definition.

    PUT and DELETE are idempotent in HTTP's sense and are still excluded
    deliberately: core's DELETE is a soft delete, so a retry that lands after a
    first attempt succeeded would answer 404 and turn a success into an error the
    caller cannot distinguish from a real one. The cold-start case this exists for
    is a page load — a GET — so nothing is lost by being strict here.
    """
    if isinstance(exc, httpx.ConnectTimeout):
        return True
    return method == "GET"


class CoreApiError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def _extract_detail(response: httpx.Response) -> str:
    """The message a caller should see for an upstream error, not the whole body.

    The core's own error responses are JSON like ``{"detail": "..."}`` —
    ``response.text`` is that ENTIRE body, so raising it as-is and then handing
    it to FastAPI's `HTTPException(detail=...)` serialises it a second time.
    The client then receives ``{"detail": "{\\"detail\\": \\"<message>\\"}"}``:
    valid JSON, but a JSON *string* rather than the message inside it, and any
    component that renders `detail` shows that raw escaped blob to a user
    (tabsii-crm#137, and independently tabsii-lms — see the note at the foot).

    Parsed rather than assumed: a non-JSON or JSON-without-`detail` upstream
    body (a proxy timeout page, a differently-shaped error) falls back to the
    raw text unchanged, so this never hides information the caller had before.

    **`detail` is not always a string, and a dict one is the same bug.** Core's
    generic CRUD layer answers an integrity error with
    ``{"detail": {"message": "...", "constraint": "..."}}``
    (`routing/crud_handlers._integrity_error_response`), which the `isinstance`
    check above rejects — so it fell to `response.text` and rebuilt
    tabsii-crm#137 exactly, one shape further in. The visible cost there was a
    delete refusal (tabsii-crm#272): the schema had written the user a sentence
    naming what still depends on the record and prescribing the remedy, and the
    browser showed the escaped JSON blob wrapped around it instead.

    So a dict `detail` carrying a **string `message`** is unwrapped to that
    message. `constraint` is deliberately dropped rather than appended — it is
    a database object name, which is the schema reconnaissance
    tabsii-platform#473 exists to keep out of a browser, and it says nothing to
    the person reading the sentence.

    Only the message key is trusted: a dict `detail` **without** one still falls
    back to the raw text, because inventing a summary from a shape nobody has
    declared would hide information rather than surface it.
    """
    try:
        body = response.json()
    except ValueError:
        return response.text
    if isinstance(body, dict):
        detail = body.get("detail")
        if isinstance(detail, str):
            return detail
        if isinstance(detail, dict) and isinstance(detail.get("message"), str):
            return detail["message"]
    return response.text


class CoreApiClient:
    """
    Thin per-request client for calling the core project's API (ADR-0002/
    ADR-0007) — this is the ONLY way this service may read or write data
    that belongs to the core. It is deliberately NOT
    packages/python-sdk's BiffoAPIClient: that client is built around a
    single static BIFFO_JWT_TOKEN env var for background/event-driven
    plugin code, not a live per-request user token. Here we forward the
    caller's own bearer token, so the core API applies the exact same
    tenant/permission scoping it would for a request made directly against
    it — this service never gets elevated privileges the calling user
    didn't already have.
    """

    def __init__(self, bearer_token: str) -> None:
        self._bearer_token = bearer_token

    async def _send(self, method: str, path: str, body: dict | None = None) -> httpx.Response:
        """Issue one core request, retrying once where that is provably safe.

        Every verb goes through here so the timeout is stated **once**. It was
        previously copied into every method, which is how it stayed at 10s while
        core's cold start grew past it — a literal repeated once per verb is one
        place to forget per verb (tabsii-crm#221).
        """
        headers = {"Authorization": f"Bearer {self._bearer_token}"}
        attempts = 2
        for attempt in range(1, attempts + 1):
            try:
                async with httpx.AsyncClient(
                    base_url=settings.core_api_url,
                    timeout=settings.core_api_timeout_seconds,
                ) as client:
                    return await client.request(method, path, json=body, headers=headers)
            except httpx.TimeoutException as exc:
                if attempt == attempts or not _may_retry(method, exc):
                    raise CoreApiError(status.HTTP_504_GATEWAY_TIMEOUT, _TIMEOUT_DETAIL) from exc
        raise AssertionError("unreachable: the loop either returns or raises")

    async def get(self, path: str) -> dict:
        response = await self._send("GET", path)
        if response.is_error:
            raise CoreApiError(response.status_code, _extract_detail(response))
        return response.json()  # type: ignore[no-any-return]

    async def post(self, path: str, body: dict) -> dict:
        response = await self._send("POST", path, body)
        if response.is_error:
            raise CoreApiError(response.status_code, _extract_detail(response))
        return response.json()  # type: ignore[no-any-return]

    async def put(self, path: str, body: dict) -> dict:
        response = await self._send("PUT", path, body)
        if response.is_error:
            raise CoreApiError(response.status_code, _extract_detail(response))
        return response.json()  # type: ignore[no-any-return]

    async def patch(self, path: str, body: dict) -> dict:
        response = await self._send("PATCH", path, body)
        if response.is_error:
            raise CoreApiError(response.status_code, _extract_detail(response))
        return response.json()  # type: ignore[no-any-return]

    async def delete(self, path: str) -> dict:
        response = await self._send("DELETE", path)
        if response.is_error:
            raise CoreApiError(response.status_code, _extract_detail(response))
        # DELETE may return an empty body; tolerate that.
        return response.json() if response.content else {}  # type: ignore[no-any-return]


def get_core_client(
    credentials: HTTPAuthorizationCredentials = Security(_security),
) -> CoreApiClient:
    if not settings.core_api_url:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="core_api_url is not configured",
        )
    return CoreApiClient(credentials.credentials)


# ── Why this file is shared, and what it cost to learn ──────────────────────
#
# Every sibling talks to core through a copy of this module. That copy used to
# drift, and the drift was expensive twice over:
#
#   • `_extract_detail` was written TWICE, independently, in two siblings
#     fixing the same user-visible bug, because neither author could discover
#     the other had already solved it (biffo-template#1107/#1108).
#   • The retry-and-timeout work was then ported a second time the same way
#     (tabsii-crm#221 -> tabsii-lms#65/#66), and the dict-`detail` fix
#     (tabsii-crm#272) reached only the repo that found it.
#
# So this file is declared in `shared-files.json` under `mustBeUniform`: the
# sync measures its variants and fails when they exceed the recorded baseline,
# rather than overwriting anybody. If you fix something here, fix it UPSTREAM in
# the skeleton and let it reach the others — a fix that lives in one sibling is
# a fix the next author will write again from scratch.
