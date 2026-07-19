"""SigV4-signing Core API client — the plugin→Core auth mechanism (ADR-0009).

A plugin reaches the Core API's internal routes (``/api/v1/internal/*``), which
API Gateway protects with IAM authorization, not Cognito JWT. So instead of a
bearer token, every request is signed with AWS SigV4 using the Lambda role's
credentials. API Gateway verifies the signature and the caller's
``execute-api:Invoke`` permission before invoking the Core Lambda, and the Core
API re-checks the resolved principal against
``BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST``.

Subclasses ``BiffoAPIClient`` so it is a drop-in ``self.api`` for
``BiffoPluginBase`` and reuses its URL building, error mapping, and JSON parsing;
only the request dispatch is overridden to sign.

``botocore`` is imported lazily (in ``_get_credentials`` and ``_sign``) so
importing ``biffo_plugin_sdk`` never requires it. It is preinstalled in the AWS
Lambda Python runtime, so a deployed plugin gains no new runtime dependency;
outside Lambda, install the ``sigv4`` extra (``biffo-plugin-sdk[sigv4]``).

This module also carries :func:`create_core_client`, the factory
``BiffoPluginBase`` uses to build its default ``self.api`` — see its docstring
for why the default is a *signing* client rather than an unauthenticated one.
"""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.parse import urlencode

from .client import BiffoAPIClient

_SERVICE = "execute-api"


class SignedCoreClient(BiffoAPIClient):
    """A ``BiffoAPIClient`` that signs each request with AWS SigV4."""

    def __init__(
        self,
        base_url: str | None = None,
        region: str | None = None,
        credentials: Any | None = None,
        service: str = _SERVICE,
        client: Any | None = None,
        timeout: float = 30.0,
    ) -> None:
        super().__init__(base_url=base_url, token=None, timeout=timeout, client=client)
        self._region = (
            region if region is not None else os.environ.get("AWS_REGION", "")
        )
        self._service = service
        self._credentials = credentials

    def _get_credentials(self) -> Any:
        """Resolve AWS credentials to sign with (the Lambda role at runtime)."""
        if self._credentials is None:
            import botocore.session

            self._credentials = botocore.session.get_session().get_credentials()
        if self._credentials is None:
            raise RuntimeError("No AWS credentials available to sign Core API requests")
        return self._credentials

    def _sign(self, method: str, url: str, body: bytes | None) -> dict[str, str]:
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest

        headers = {"Content-Type": "application/json"} if body is not None else {}
        aws_request = AWSRequest(method=method, url=url, data=body, headers=headers)
        SigV4Auth(self._get_credentials(), self._service, self._region).add_auth(
            aws_request
        )
        return dict(aws_request.headers)

    async def _send(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> Any:
        url = self._url(path)
        if params:
            url = f"{url}?{urlencode(params)}"
        body = json.dumps(json_body).encode() if json_body is not None else None
        headers = self._sign(method, url, body)
        response = await self._client.request(
            method, url, headers=headers, content=body
        )
        self._raise_if_error(response)
        return self._parse_json(response)

    async def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        return await self._send("GET", path, params=params)

    async def post(self, path: str, json: dict[str, Any] | None = None) -> Any:
        return await self._send("POST", path, json_body=json)

    async def put(self, path: str, json: dict[str, Any] | None = None) -> Any:
        return await self._send("PUT", path, json_body=json)

    async def delete(self, path: str) -> Any:
        return await self._send("DELETE", path)


_AUTH_MODE_ENV = "BIFFO_CORE_AUTH_MODE"


def create_core_client(**kwargs: Any) -> BiffoAPIClient:
    """Build the Core API client a plugin should use, defaulting to SigV4.

    The default is deliberately the *signing* client. ADR-0009 makes IAM SigV4
    the plugin->Core mechanism, so an unsigned client is not a working default
    for anything — it silently produces 403s against a protected API. Making the
    signing path opt-in is what left the platform with a documented-but-absent
    auth story in the first place (issues #194, #197), so the SDK now fails
    *visibly* (a signing error) rather than *silently* (an unauthenticated call).

    Set ``BIFFO_CORE_AUTH_MODE=none`` to get a plain unsigned ``BiffoAPIClient``
    — for local runs, tests, or a plugin that only talks to an unprotected
    endpoint. Any other value is rejected rather than guessed at.
    """
    mode = os.environ.get(_AUTH_MODE_ENV, "sigv4").strip().lower() or "sigv4"
    if mode == "sigv4":
        return SignedCoreClient(**kwargs)
    if mode == "none":
        kwargs.pop("region", None)
        kwargs.pop("credentials", None)
        kwargs.pop("service", None)
        return BiffoAPIClient(**kwargs)
    raise ValueError(
        f"Invalid {_AUTH_MODE_ENV}={mode!r}: expected 'sigv4' (default) or 'none'"
    )
