"""Pure Cognito RS256 JWT verification.

Extracted verbatim (behaviour-for-behaviour) from the Core API's
``middleware/auth.py`` so the agent runtime can reuse it (ADR-0016 §7) without
either service depending on the other. The one intentional shape change is that
this module raises its own :class:`CognitoJWTError` family instead of FastAPI's
``HTTPException`` — keeping it framework-free — and the caller translates those
onto its transport. Core's translation reproduces the exact status/detail it
raised before, so its behaviour and tests are unchanged.
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import cast

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
from jwt import PyJWTError
from jwt.algorithms import RSAAlgorithm


class CognitoJWTError(Exception):
    """Verification failed. ``str(self)`` is a safe, caller-facing reason (a fixed
    string or provider output) — it never contains the token or a key."""


class MalformedTokenError(CognitoJWTError):
    """The token is not a well-formed JWT (its header could not be read)."""


class UnknownSigningKeyError(CognitoJWTError):
    """No JWKS key matched the token's ``kid``, even after a cache-bust retry."""


class TokenVerificationError(CognitoJWTError):
    """Signature, audience, expiry, or another claim check failed."""


@lru_cache(maxsize=1)
def _fetch_jwks(user_pool_id: str, region: str) -> dict:
    """Fetch and cache a pool's JWKS. Cached for the life of the (Lambda) process.

    Only used on the remote path — when no baked ``jwks_json`` is supplied. Key
    rotation is handled by the cache-bust-and-retry in :func:`verify_cognito_jwt`.
    """
    url = f"https://cognito-idp.{region}.amazonaws.com/{user_pool_id}/.well-known/jwks.json"
    response = httpx.get(url, timeout=10)
    response.raise_for_status()
    return response.json()  # type: ignore[no-any-return]


def _load_jwks(user_pool_id: str, region: str, jwks_json: str | None) -> dict:
    """The JWKS to verify against: the baked document when supplied (no-NAT dev,
    Terraform bakes it in at apply time), otherwise the cached remote fetch."""
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
) -> dict:
    """Verify a Cognito RS256 JWT and return its claims.

    Behaviour carried over from Core's inline verifier:

    - the signing key is matched from the pool's JWKS by the token header's
      ``kid`` (baked ``jwks_json`` when supplied, else the cached remote fetch);
    - on a remote fetch an unknown ``kid`` busts the JWKS cache and retries once,
      to tolerate key rotation — the baked path never retries;
    - the signature is verified as ``RS256`` with ``audience=client_id``; expiry
      and the other standard claims are enforced by PyJWT.

    Raises a :class:`CognitoJWTError` subclass on failure; ``str(exc)`` is always
    safe to surface (it never carries the token or a key).
    """
    try:
        unverified_headers = jwt.get_unverified_header(token)
    except PyJWTError as exc:
        raise MalformedTokenError("Malformed token") from exc

    kid = unverified_headers.get("kid")
    jwks = _load_jwks(user_pool_id, region, jwks_json)
    signing_key = next((k for k in jwks["keys"] if k["kid"] == kid), None)

    if signing_key is None and not jwks_json:
        # Unknown kid and we can fetch remotely — the JWKS may have rotated; bust
        # the cache and retry once.
        _fetch_jwks.cache_clear()
        jwks = _load_jwks(user_pool_id, region, jwks_json)
        signing_key = next((k for k in jwks["keys"] if k["kid"] == kid), None)

    if signing_key is None:
        raise UnknownSigningKeyError("Unknown signing key")

    try:
        # PyJWT needs a key object, not a raw JWK dict — convert the matched JWK.
        # A Cognito JWKS only publishes public keys, so this is always public.
        public_key = cast(RSAPublicKey, RSAAlgorithm.from_jwk(json.dumps(signing_key)))
        claims: dict = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            audience=client_id,
        )
    except PyJWTError as exc:
        raise TokenVerificationError(f"Token invalid: {exc}") from exc

    return claims
