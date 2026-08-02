import httpx
from fastapi import HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import settings

_security = HTTPBearer()


class CoreApiError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def _extract_detail(response: httpx.Response) -> str:
    """The message a caller should see for an upstream error, not the whole body.

    The core's own error responses are JSON like ``{"detail": "..."}`` --
    ``response.text`` is that ENTIRE body, so raising it as-is and then handing
    it to FastAPI's ``HTTPException(detail=...)`` serialises it a second time.
    The client then receives ``{"detail": "{\\"detail\\": \\"<message>\\"}"}``:
    valid JSON, but a JSON *string* rather than the message inside it, and any
    component that renders ``detail`` shows that raw escaped blob to a user
    (tabsii-crm#137).

    Parsed rather than assumed: a non-JSON or JSON-without-``detail`` upstream
    body (a proxy timeout page, a differently-shaped error) falls back to the
    raw text unchanged, so this never hides information the caller had before.

    Fixed in two siblings independently before it was ever fixed HERE, which is
    why three more were still shipping ``response.text`` months later. The
    browser-side twin is ``extractErrorMessage`` in
    ``apps/frontend/src/lib/api-client.ts``; keep the two in step.
    """
    try:
        body = response.json()
    except ValueError:
        return response.text
    if isinstance(body, dict) and isinstance(body.get("detail"), str):
        return body["detail"]
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

    async def get(self, path: str) -> dict:
        async with httpx.AsyncClient(base_url=settings.core_api_url, timeout=10) as client:
            response = await client.get(
                path,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        if response.is_error:
            raise CoreApiError(response.status_code, _extract_detail(response))
        return response.json()  # type: ignore[no-any-return]

    async def post(self, path: str, body: dict) -> dict:
        async with httpx.AsyncClient(base_url=settings.core_api_url, timeout=10) as client:
            response = await client.post(
                path,
                json=body,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        if response.is_error:
            raise CoreApiError(response.status_code, _extract_detail(response))
        return response.json()  # type: ignore[no-any-return]


def get_core_client(
    credentials: HTTPAuthorizationCredentials = Security(_security),
) -> CoreApiClient:
    if not settings.core_api_url:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="core_api_url is not configured",
        )
    return CoreApiClient(credentials.credentials)
