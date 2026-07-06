"""SigV4-signing Core API client for the orchestration engine (ADR-0009).

The engine reaches the Core API's internal routes (``/api/v1/internal/*``),
which API Gateway protects with IAM authorization, not Cognito JWT. So instead of
the SDK ``BiffoAPIClient``'s bearer token, every request is signed with AWS SigV4
using the Lambda role's credentials. API Gateway verifies the signature and the
caller's ``execute-api:Invoke`` permission before invoking the Core Lambda.

Subclasses ``BiffoAPIClient`` so it is a drop-in ``self.api`` for
``BiffoPluginBase`` and reuses its URL building, error mapping, and JSON parsing;
only the request dispatch is overridden to sign.
"""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.parse import urlencode

from biffo_plugin_sdk import BiffoAPIClient

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
