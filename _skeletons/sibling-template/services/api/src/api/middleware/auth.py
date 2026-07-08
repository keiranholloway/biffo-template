import json
from dataclasses import dataclass
from functools import lru_cache
from typing import cast

import httpx
import jwt
from aws_lambda_powertools import Logger
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
from fastapi import HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWTError
from jwt.algorithms import RSAAlgorithm

from ..config import settings

logger = Logger()
_security = HTTPBearer()


@dataclass(frozen=True)
class AuthenticatedUser:
    """Verified identity extracted from the core project's Cognito JWT."""

    sub: str
    email: str
    username: str


# Ported near-verbatim from the core project's services/api/src/api/middleware/auth.py
# (ADR-0007) — this sibling's API Gateway already has its own Cognito JWT
# authorizer (see modules/cloud/aws/api-gateway), so a request only reaches
# this Lambda at all if a valid token was already presented. This second,
# independent verification is deliberate defense in depth, not redundant:
# it means the Lambda's own authorization logic never trusts API Gateway's
# authorizer having run correctly, matching how the core API itself behaves.
@lru_cache(maxsize=1)
def _get_jwks(user_pool_id: str, region: str) -> dict:
    """Fetch and cache JWKS. Cached per Lambda instance lifetime."""
    if settings.cognito_jwks_json:
        return json.loads(settings.cognito_jwks_json)  # type: ignore[no-any-return]
    url = f"https://cognito-idp.{region}.amazonaws.com/{user_pool_id}/.well-known/jwks.json"
    response = httpx.get(url, timeout=10)
    response.raise_for_status()
    return response.json()  # type: ignore[no-any-return]


def _verify_token(token: str) -> dict:
    try:
        unverified_headers = jwt.get_unverified_header(token)
    except PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Malformed token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    kid = unverified_headers.get("kid")
    jwks = _get_jwks(settings.cognito_user_pool_id, settings.cognito_region)
    signing_key = next((k for k in jwks["keys"] if k["kid"] == kid), None)

    if signing_key is None and not settings.cognito_jwks_json:
        # Unknown kid and we can fetch remotely — JWKS may have rotated;
        # bust the cache and retry once.
        _get_jwks.cache_clear()
        jwks = _get_jwks(settings.cognito_user_pool_id, settings.cognito_region)
        signing_key = next((k for k in jwks["keys"] if k["kid"] == kid), None)

    if signing_key is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unknown signing key",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        # PyJWT needs a key object, not a raw JWK dict — convert the matched JWK.
        # A Cognito JWKS only publishes public keys, so this is always public.
        public_key = cast(RSAPublicKey, RSAAlgorithm.from_jwk(json.dumps(signing_key)))
        claims: dict = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            audience=settings.cognito_client_id,
        )
    except PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Token invalid: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    return claims


async def require_auth(
    credentials: HTTPAuthorizationCredentials = Security(_security),
) -> AuthenticatedUser:
    """
    FastAPI dependency that verifies the core project's Cognito JWT and
    returns the caller's identity.

    Raises HTTP 401 if the token is missing, expired, or invalid.
    """
    claims = _verify_token(credentials.credentials)

    return AuthenticatedUser(
        sub=claims["sub"],
        email=claims.get("email", ""),
        username=claims.get("cognito:username", claims.get("username", "")),
    )
