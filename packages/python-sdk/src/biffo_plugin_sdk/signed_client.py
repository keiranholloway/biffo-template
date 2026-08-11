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
from contextvars import ContextVar
from typing import Any
from urllib.parse import urlencode

from .client import BiffoAPIClient

_SERVICE = "execute-api"

#: The header a caller uses to assert *which* plugin identity it is acting as
#: (ADR-0021 §1a). Only honoured by Core when the SigV4 caller is the shared
#: plugin host — the host has one IAM role but serves many plugins, so it names
#: the plugin per request; a plugin with its own role is identified by that role
#: and this header is ignored. Signed (added before SigV4) so it cannot be
#: tampered with in transit.
PLUGIN_IDENTITY_HEADER = "X-Biffo-Plugin"

#: Set by the shared plugin host (plugin_host.mount) to the name of the plugin
#: whose request is being served, so that plugin's :class:`SignedCoreClient`
#: calls to Core assert that identity. Unset (``None``) outside the host — a
#: plugin running in its own Lambda asserts nothing and is identified by its role.
acting_as_plugin: ContextVar[str | None] = ContextVar("biffo_acting_as_plugin", default=None)

#: Header a SigV4-signed request carries the calling user's own Cognito token
#: in, alongside the signature — the "principal" dual-auth pattern (issue
#: #1490). Must match Core's own ``middleware/forwarded_user.FORWARDED_USER_HEADER``
#: and the shared plugin host's ``plugin_host.forward.FORWARDED_USER_HEADER``,
#: which this SDK constant is now the canonical source for: three independent
#: copies of this exact string (the plugin host, and two hand-rolled plugin
#: transports) had already drifted apart on where the token is added relative
#: to signing before this constant existed to keep them in step.
FORWARDED_USER_HEADER = "X-Biffo-User-Token"


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
        self._region = region if region is not None else os.environ.get("AWS_REGION", "")
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

    def _sign(
        self,
        method: str,
        url: str,
        body: bytes | None,
        extra: dict[str, str] | None = None,
    ) -> dict[str, str]:
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest

        headers = {"Content-Type": "application/json"} if body is not None else {}
        # Caller-supplied headers go in BEFORE signing, for the same reason the
        # plugin identity does: anything the receiver trusts must be covered by
        # the signature, or it can be altered in transit.
        if extra:
            headers.update(extra)
        # ADR-0021 §1a: assert the plugin identity the shared host is acting as, so
        # Core can grant `system:<plugin>` rather than the host's own role identity.
        # Added BEFORE signing so it is covered by the SigV4 signature.
        identity = acting_as_plugin.get()
        if identity:
            headers[PLUGIN_IDENTITY_HEADER] = identity
        aws_request = AWSRequest(method=method, url=url, data=body, headers=headers)
        SigV4Auth(self._get_credentials(), self._service, self._region).add_auth(aws_request)
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
        response = await self._client.request(method, url, headers=headers, content=body)
        self._raise_if_error(response)
        return self._parse_json(response)

    async def raw_request(
        self,
        method: str,
        path: str,
        *,
        content: bytes | None = None,
        extra_signed_headers: dict[str, str] | None = None,
    ) -> tuple[int, bytes, str]:
        """A signed request returning ``(status, body, content_type)`` verbatim.

        Unlike :meth:`get`/:meth:`post`, this does **not** raise on a non-2xx and
        does not parse the body. It exists for proxying, where the upstream
        status is the answer and must reach the original caller unchanged — the
        shared plugin host forwarding a plugin's declared ``api_routes`` to Core
        (#652) needs a 403 from Core's permission check to arrive as a 403, not
        as an exception it would have to invent a status for.

        ``extra_signed_headers`` are included before signing, so a header the
        receiver authenticates on (the forwarded user token) is covered by the
        signature rather than appended to a signed request afterwards.
        """
        url = self._url(path)
        headers = self._sign(method, url, content, extra_signed_headers)
        response = await self._client.request(method, url, headers=headers, content=content)
        return (
            response.status_code,
            response.content,
            response.headers.get("content-type", "application/json"),
        )

    async def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        return await self._send("GET", path, params=params)

    async def post(self, path: str, json: dict[str, Any] | None = None) -> Any:
        return await self._send("POST", path, json_body=json)

    async def put(self, path: str, json: dict[str, Any] | None = None) -> Any:
        return await self._send("PUT", path, json_body=json)

    async def patch(self, path: str, json: dict[str, Any] | None = None) -> Any:
        return await self._send("PATCH", path, json_body=json)

    async def delete(self, path: str) -> Any:
        return await self._send("DELETE", path)


class PrincipalCoreClient(SignedCoreClient):
    """A ``SignedCoreClient`` that also forwards the calling user's own token —
    the "dual-auth" pattern (issue #1490) a plugin needs to reach Core's
    per-plugin internal CRUD mount under the *user's* identity rather than only
    the plugin's own.

    Consolidates three independent implementations of exactly this shape:
    ``services/_plugin-host/src/plugin_host/app.py::core_sender`` (this repo,
    the reference — already correct, using ``raw_request``'s
    ``extra_signed_headers``), and two hand-rolled ``CoreTransport`` subclasses
    in ``biffo-plugin-idea-scout`` and ``biffo-plugin-ideation`` that instead
    added the header to the dict ``_sign()`` returned, i.e. **after** signing —
    outside the SigV4-covered header set. ``biffo-plugin-marketing``'s
    ``PrincipalCoreClient`` (the name this class borrows) got it right by
    building on ``raw_request`` directly, the same way the plugin host does.

    The fix is structural, not a call-site discipline: overriding ``_sign``
    (SignedCoreClient's single signing choke point, also used internally by
    ``get``/``post``/``put``/``patch``/``delete`` and by ``raw_request``) means
    every request path this class exposes carries the forwarded token inside
    the signature automatically — there is no second place a caller could add
    it after the fact and get it wrong.

    ``user_token`` is bound once per client, matching every existing caller's
    lifecycle: idea-scout/ideation's ``CoreTransport`` and marketing's
    ``PrincipalCoreClient`` are both constructed fresh per founder/admin
    request, never shared across identities.
    """

    def __init__(
        self,
        user_token: str,
        *,
        base_url: str | None = None,
        region: str | None = None,
        credentials: Any | None = None,
        service: str = _SERVICE,
        client: Any | None = None,
        timeout: float = 30.0,
    ) -> None:
        super().__init__(
            base_url=base_url,
            region=region,
            credentials=credentials,
            service=service,
            client=client,
            timeout=timeout,
        )
        self._user_token = user_token

    def _sign(
        self,
        method: str,
        url: str,
        body: bytes | None,
        extra: dict[str, str] | None = None,
    ) -> dict[str, str]:
        # Merged in BEFORE calling the base signer, same as the plugin-identity
        # header below it: anything the receiver authenticates on must be
        # covered by the signature, or a man-in-the-middle on the internal hop
        # could strip or replace it without invalidating SigV4.
        merged = dict(extra) if extra else {}
        merged[FORWARDED_USER_HEADER] = self._user_token
        return super()._sign(method, url, body, merged)


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
    raise ValueError(f"Invalid {_AUTH_MODE_ENV}={mode!r}: expected 'sigv4' (default) or 'none'")
