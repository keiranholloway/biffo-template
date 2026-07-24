"""Self-contained Cognito RS256 JWT verification for the published SDK.

A **deliberate mirror** of ``packages/cognito-auth`` (``biffo_cognito_auth``). Core
and the agent runtime share that workspace package (ADR-0016 §7 / #492), but the
SDK is published to PyPI for third-party plugin authors and **cannot depend on an
unpublished workspace package** — so it carries its own copy, the same way
``RouteDef`` mirrors Core's ``RouteDefinition`` (see ``plugin_route.py``). The
behaviour is byte-for-byte the same: RS256, ``audience = client_id``, a baked-JWKS
fast path, and a cache-bust-and-retry on an unknown ``kid``.

**If either side's verification behaviour changes, update the other.** Depends only
on PyPI packages (``pyjwt[crypto]`` for RS256, ``httpx`` — already an SDK
dependency), so ``biffo-plugin-sdk[user-serving]`` installs cleanly from PyPI.
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any, cast

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
from jwt import PyJWTError
from jwt.algorithms import RSAAlgorithm


class CognitoJWTError(Exception):
    """Verification failed. ``str(self)`` is a safe, caller-facing reason — it never
    contains the token or a key."""


class MalformedTokenError(CognitoJWTError):
    """The token is not a well-formed JWT (its header could not be read)."""


class UnknownSigningKeyError(CognitoJWTError):
    """No JWKS key matched the token's ``kid``, even after a cache-bust retry."""


class TokenVerificationError(CognitoJWTError):
    """Signature, audience, expiry, or another claim check failed."""


@lru_cache(maxsize=1)
def _fetch_jwks(user_pool_id: str, region: str) -> dict[str, Any]:
    """Fetch and cache a pool's JWKS for the life of the (Lambda) process. Key
    rotation is handled by the cache-bust-and-retry in :func:`verify_cognito_jwt`."""
    url = f"https://cognito-idp.{region}.amazonaws.com/{user_pool_id}/.well-known/jwks.json"
    response = httpx.get(url, timeout=10)
    response.raise_for_status()
    return response.json()  # type: ignore[no-any-return]


def _load_jwks(user_pool_id: str, region: str, jwks_json: str | None) -> dict[str, Any]:
    """The JWKS to verify against: the baked document when supplied, else the cached
    remote fetch."""
    if jwks_json:
        return json.loads(jwks_json)  # type: ignore[no-any-return]
    return _fetch_jwks(user_pool_id, region)


def verify_cognito_jwt(
    token: str,
    *,
    user_pool_id: str,
    region: str,
    client_id: str,
    jwks_json: str | None = None,
) -> dict[str, Any]:
    """Verify a Cognito RS256 JWT and return its claims, or raise a
    :class:`CognitoJWTError` subclass. Mirrors ``biffo_cognito_auth.verify_cognito_jwt``."""
    try:
        unverified_headers = jwt.get_unverified_header(token)
    except PyJWTError as exc:
        raise MalformedTokenError("Malformed token") from exc

    kid = unverified_headers.get("kid")
    jwks = _load_jwks(user_pool_id, region, jwks_json)
    signing_key = next((k for k in jwks["keys"] if k["kid"] == kid), None)

    if signing_key is None and not jwks_json:
        # Unknown kid and we can fetch remotely — the JWKS may have rotated; bust the
        # cache and retry once.
        _fetch_jwks.cache_clear()
        jwks = _load_jwks(user_pool_id, region, jwks_json)
        signing_key = next((k for k in jwks["keys"] if k["kid"] == kid), None)

    if signing_key is None:
        raise UnknownSigningKeyError("Unknown signing key")

    try:
        public_key = cast(RSAPublicKey, RSAAlgorithm.from_jwk(json.dumps(signing_key)))
        claims: dict[str, Any] = jwt.decode(
            token, public_key, algorithms=["RS256"], audience=client_id
        )
    except PyJWTError as exc:
        raise TokenVerificationError(f"Token invalid: {exc}") from exc

    return claims
