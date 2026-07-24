"""Authenticated user-facing serving for a plugin's Lambda ingress (ADR-0018 §1).

A user-facing plugin's Lambda is reached by a **logged-in founder** through the
shared CloudFront, so it must authenticate every request itself: verify the
shared-Cognito JWT (the same verifier Core uses) and require a declared group.
This module is that gate, reusable by any user-facing plugin.

The security logic lives in the pure :func:`authorize` (no web framework, an
injectable verifier), so it is fully testable without FastAPI or a real token;
:func:`require_group` is a thin FastAPI dependency over it. FastAPI and the Cognito
verifier are imported lazily, so ``import biffo_plugin_sdk`` never requires them —
install ``biffo-plugin-sdk[user-serving]`` to use this module.

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
    from biffo_cognito_auth import verify_cognito_jwt

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
    from biffo_cognito_auth import CognitoJWTError

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


def require_group(
    group: str,
    *,
    config: CognitoConfig | None = None,
    verify: Verifier | None = None,
) -> Callable[..., ForwardedUser]:
    """A FastAPI dependency: verify the ``Authorization: Bearer`` JWT and require
    ``group``, returning the :class:`ForwardedUser`. 401 on a missing/invalid token,
    403 on the wrong group. ``config`` defaults to :meth:`CognitoConfig.from_env`
    (resolved per request)."""
    from fastapi import Header, HTTPException

    def dependency(
        authorization: str | None = Header(default=None, alias="Authorization"),
    ) -> ForwardedUser:
        token = ""
        if authorization and authorization.lower().startswith("bearer "):
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
