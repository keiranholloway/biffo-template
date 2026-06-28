from dataclasses import dataclass
from functools import lru_cache

import httpx
from aws_lambda_powertools import Logger
from fastapi import HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from ..config import settings

logger = Logger()
_security = HTTPBearer()


@dataclass(frozen=True)
class AuthenticatedUser:
    """Verified identity extracted from the Cognito JWT."""

    sub: str
    email: str
    username: str
    tenant_id: str  # Always "default" in single-tenant deployments (ADR-0001)


@lru_cache(maxsize=1)
def _get_jwks(user_pool_id: str, region: str) -> dict:
    """Fetch and cache JWKS from Cognito. Cached per Lambda instance lifetime."""
    url = f"https://cognito-idp.{region}.amazonaws.com/{user_pool_id}/.well-known/jwks.json"
    response = httpx.get(url, timeout=10)
    response.raise_for_status()
    return response.json()  # type: ignore[no-any-return]


def _verify_token(token: str) -> dict:
    try:
        unverified_headers = jwt.get_unverified_headers(token)
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Malformed token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    kid = unverified_headers.get("kid")
    jwks = _get_jwks(settings.cognito_user_pool_id, settings.cognito_region)
    signing_key = next((k for k in jwks["keys"] if k["kid"] == kid), None)

    if signing_key is None:
        # Unknown kid — JWKS may have rotated; bust the cache and retry once
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
        claims: dict = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            audience=settings.cognito_client_id,
        )
    except JWTError as exc:
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
    FastAPI dependency that verifies the Cognito JWT and returns the caller's identity.

    Raises HTTP 401 if the token is missing, expired, or invalid.
    The tenant_id is always 'default' in single-tenant deployments (ADR-0001).
    When multi-tenancy is added, it will be sourced from a custom Cognito claim.
    """
    claims = _verify_token(credentials.credentials)

    return AuthenticatedUser(
        sub=claims["sub"],
        email=claims.get("email", ""),
        username=claims.get("cognito:username", claims.get("username", "")),
        tenant_id="default",
    )
