"""Founder JWT authorization for an ``isolated: true`` plugin's own Lambda ingress.

The pure :func:`authorize` (shared-Cognito JWT verification + group check, no web
framework, an injectable verifier) is the platform's shared authorization
primitive — the shared plugin-host's own authorizer (``plugin_host.authz``) wraps
it to enforce group-gating for every plugin mounted in the host.

:func:`require_group` is a thin FastAPI dependency over :func:`authorize`, and
exists **only** for a plugin that declares ``isolated: true`` (ADR-0021's escape
hatch): it runs in its own dedicated Lambda, outside the shared host's
``group_gate``, so nothing upstream authenticates its requests or enforces its
declared group for it — the plugin must do that itself, and this is the gate for
it. A plugin mounted in the shared plugin-host must **not** use
:func:`require_group` — group-gating there is already enforced by the host
itself, from the plugin's declared `api_ingress.required_group` (ADR-0011,
ADR-0021 §1). A plugin shipping its own auth code in that context is redundant
at best, and an unreviewed, divergent enforcement path at worst.

FastAPI and the JWT verifier are imported lazily, so ``import biffo_plugin_sdk``
never requires them — install ``biffo-plugin-sdk[user-serving]`` to use this
module. The verifier is the SDK's self-contained ``_cognito`` (a published SDK
cannot depend on the internal ``biffo_cognito_auth`` workspace package;
``_cognito`` mirrors it).

The verified founder carries its **raw token** so the handler can forward it to
Core in the ``X-Biffo-User-Token`` header — Core re-verifies identity and
owner-scopes (ADR-0017 §3/§5); the plugin gate is defence-in-depth.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

_GROUPS_CLAIM = "cognito:groups"


class UserAuthError(Exception):
    """Base for a rejected user request at the plugin's ingress."""


class UnauthorizedError(UserAuthError):
    """No usable token, or it failed verification (→ 401)."""


class ForbiddenError(UserAuthError):
    """A verified user who is not in the required group (→ 403)."""


@dataclass(frozen=True)
class ForwardedUser:
    """A verified founder. ``token`` is the raw bearer JWT, forwarded to Core."""

    sub: str
    groups: list[str]
    token: str


@dataclass(frozen=True)
class CognitoConfig:
    """The shared Cognito pool/client the ingress verifies against — the *same*
    pool/client as the portal and Core (ADR-0007/ADR-0018)."""

    user_pool_id: str
    region: str
    client_id: str
    jwks_json: str | None = None

    @classmethod
    def from_env(cls) -> CognitoConfig:
        """Read the shared-Cognito config the plugin's Lambda is provisioned with
        (``BIFFO_COGNITO_*`` env, baked by install/terraform, ADR-0018 §3)."""
        try:
            return cls(
                user_pool_id=os.environ["BIFFO_COGNITO_USER_POOL_ID"],
                region=os.environ["BIFFO_COGNITO_REGION"],
                client_id=os.environ["BIFFO_COGNITO_CLIENT_ID"],
                jwks_json=os.environ.get("BIFFO_COGNITO_JWKS_JSON") or None,
            )
        except KeyError as exc:
            raise UserAuthError(
                f"The user-facing ingress is missing Cognito config: {exc} is unset."
            ) from exc


#: A verifier: ``(token, *, user_pool_id, region, client_id, jwks_json) -> claims``.
#: Defaults to the shared ``biffo_cognito_auth.verify_cognito_jwt``.
Verifier = Callable[..., dict[str, Any]]


def _default_verifier() -> Verifier:
    from ._cognito import verify_cognito_jwt

    return verify_cognito_jwt


def authorize(
    token: str,
    *,
    required_group: str,
    config: CognitoConfig,
    verify: Verifier | None = None,
) -> ForwardedUser:
    """Verify ``token`` against the shared Cognito pool and require ``required_group``.

    Pure and framework-free. Raises :class:`UnauthorizedError` if the token is empty or
    fails verification, :class:`ForbiddenError` if the verified user is not in the group.
    ``verify`` is injectable so this is testable without a real JWT.
    """
    if not token:
        raise UnauthorizedError("No bearer token.")
    verify = verify or _default_verifier()
    from ._cognito import CognitoJWTError

    try:
        claims = verify(
            token,
            user_pool_id=config.user_pool_id,
            region=config.region,
            client_id=config.client_id,
            jwks_json=config.jwks_json,
        )
    except CognitoJWTError as exc:
        raise UnauthorizedError(str(exc)) from exc

    groups = [str(g) for g in (claims.get(_GROUPS_CLAIM) or [])]
    if required_group not in groups:
        raise ForbiddenError(f"This surface requires the {required_group!r} group.")
    return ForwardedUser(sub=str(claims["sub"]), groups=groups, token=token)


#: The header a user-facing plugin's founder JWT travels in (ADR-0018). NOT
#: ``Authorization``: behind CloudFront OAC the Function URL is invoked with SigV4,
#: which claims the ``Authorization`` header for its signature, so the bearer token
#: must ride a header CloudFront does not touch.
FOUNDER_TOKEN_HEADER = "X-Biffo-Founder-Token"  # noqa: S105 - a header name, not a secret


def _extract_bearer(value: str | None) -> str:
    """The raw JWT from a header value, tolerating a ``Bearer `` prefix or a bare token."""
    if not value:
        return ""
    if value.lower().startswith("bearer "):
        return value.split(" ", 1)[1].strip()
    return value.strip()


def require_group(
    group: str,
    *,
    config: CognitoConfig | None = None,
    verify: Verifier | None = None,
) -> Callable[..., ForwardedUser]:
    """A FastAPI dependency: verify the founder JWT and require ``group``, returning
    the :class:`ForwardedUser`. 401 on a missing/invalid token, 403 on the wrong
    group. ``config`` defaults to :meth:`CognitoConfig.from_env` (resolved per
    request).

    Only for ``isolated: true`` plugins running in their own Lambda. Do not use
    this in a plugin mounted in the shared plugin-host — the host's
    ``group_gate`` already enforces this (ADR-0021).

    The token is read from the ``X-Biffo-Founder-Token`` header (see
    :data:`FOUNDER_TOKEN_HEADER`) — behind CloudFront OAC the ``Authorization``
    header is consumed by SigV4 signing (ADR-0018). ``Authorization: Bearer`` is
    still accepted as a fallback for direct/local invocation without OAC."""
    from fastapi import Header, HTTPException

    def dependency(
        x_biffo_founder_token: str | None = Header(default=None, alias=FOUNDER_TOKEN_HEADER),
        authorization: str | None = Header(default=None, alias="Authorization"),
    ) -> ForwardedUser:
        # The custom header carries the raw JWT (optionally "Bearer "-prefixed).
        # Authorization is a strict-Bearer fallback only — a non-Bearer scheme
        # (e.g. "Basic …") is not a founder token and is ignored.
        token = _extract_bearer(x_biffo_founder_token)
        if not token and authorization and authorization.lower().startswith("bearer "):
            token = authorization.split(" ", 1)[1].strip()
        try:
            return authorize(
                token,
                required_group=group,
                config=config or CognitoConfig.from_env(),
                verify=verify,
            )
        except ForbiddenError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except UserAuthError as exc:  # UnauthorizedError (and any config error) → 401
            raise HTTPException(status_code=401, detail=str(exc)) from exc

    return dependency
