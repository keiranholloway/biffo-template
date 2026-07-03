import json
from dataclasses import dataclass, field
from functools import lru_cache

import httpx
from aws_lambda_powertools import Logger
from fastapi import Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from ..models.user import User

logger = Logger()
_security = HTTPBearer()


@dataclass(frozen=True)
class AuthenticatedUser:
    """Verified identity extracted from the Cognito JWT."""

    sub: str
    email: str
    username: str
    tenant_id: str  # Always "default" in single-tenant deployments (ADR-0001)
    # Group memberships from the verified JWT's `cognito:groups` claim, used by
    # the generic CRUD layer's declarative permission checks (ADR-0004). Empty
    # when the caller belongs to no groups — the permission model is any-of
    # against this list, so an empty list authorises only operations that
    # require no role. Defaults to empty so non-auth construction sites (tests,
    # dependency overrides) stay fail-closed without having to opt in.
    roles: list[str] = field(default_factory=list)


@lru_cache(maxsize=1)
def _get_jwks(user_pool_id: str, region: str) -> dict:
    """Fetch and cache JWKS. Cached per Lambda instance lifetime.

    When BIFFO_COGNITO_JWKS_JSON is set (no-NAT dev environments), the JWKS is
    read from the env var instead of making an outbound call to Cognito. Terraform
    bakes it in at apply time. Key rotation in that environment requires a
    terraform apply to refresh the env var.
    """
    if settings.cognito_jwks_json:
        return json.loads(settings.cognito_jwks_json)  # type: ignore[no-any-return]
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

    if signing_key is None and not settings.cognito_jwks_json:
        # Unknown kid and we can fetch remotely — JWKS may have rotated; bust the cache and retry once.
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


def identity_from_token(
    credentials: HTTPAuthorizationCredentials,
) -> AuthenticatedUser:
    """Verify the Cognito JWT and map its claims to the caller's identity.

    Pure — no DB. The tenant_id is always 'default' in single-tenant deployments
    (ADR-0001). Roles come from the `cognito:groups` claim already present in the
    verified token (ADR-0004) — no extra round-trip. The claim is absent for a
    caller in no groups; it is a JSON array of group names when present.
    """
    claims = _verify_token(credentials.credentials)

    return AuthenticatedUser(
        sub=claims["sub"],
        email=claims.get("email", ""),
        username=claims.get("cognito:username", claims.get("username", "")),
        tenant_id="default",
        roles=list(claims.get("cognito:groups") or []),
    )


async def _ensure_active(db: AsyncSession, cognito_sub: str) -> None:
    """Reject a deactivated user (issue #150).

    Cognito's suspend flow (AdminDisableUser + AdminUserGlobalSignOut) revokes
    refresh tokens immediately, but an already-issued access token stays valid
    until it expires (~1h). Enforcing the DB `users.is_active` flag — set by the
    admin suspend/reactivate endpoints — on every request closes that window.
    A user with no row yet (provisioned but never logged in) is treated as
    active; the row is created on first login.
    """
    result = await db.execute(
        select(User.is_active).where(User.cognito_sub == cognito_sub)
    )
    if result.scalar_one_or_none() is False:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account is deactivated",
            headers={"WWW-Authenticate": "Bearer"},
        )


async def require_auth(
    credentials: HTTPAuthorizationCredentials = Security(_security),
    db: AsyncSession = Depends(get_db),
) -> AuthenticatedUser:
    """
    FastAPI dependency: verify the Cognito JWT, enforce the user isn't
    deactivated, and return the caller's identity.

    Raises HTTP 401 if the token is missing/expired/invalid, or if the user's
    DB row is marked inactive (issue #150). This is the single authorization
    seam every authenticated route flows through, so the is_active check applies
    everywhere — at the cost of one indexed lookup by `cognito_sub` per request.
    """
    user = identity_from_token(credentials)
    await _ensure_active(db, user.sub)
    return user
