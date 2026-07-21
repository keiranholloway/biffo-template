import json
from dataclasses import dataclass, field, replace
from functools import lru_cache
from typing import cast

import httpx
import jwt
from aws_lambda_powertools import Logger
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
from fastapi import Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWTError
from jwt.algorithms import RSAAlgorithm
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..identity import get_identity_provider, identity_session

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
    # Resolved by the ADR-0012 identity provider in require_auth. Defaults are
    # fail-closed so non-auth construction sites (tests, dependency overrides,
    # identity_from_token) grant nothing they haven't been given: no identity,
    # not an admin, no permissions.
    #
    # The deployment's canonical id for this caller. None when no record exists
    # yet, or when the deployment keeps no local identity row at all — so treat
    # it as "unknown", never as "not authenticated".
    user_id: str | None = None
    # Mirrors the platform-admin Cognito group on the verified token.
    is_platform_admin: bool = False
    # Effective permission codes from database-held roles, for deployments that
    # grant permissions that way. Empty under the ADR-0004 default model, which
    # authorises from `roles` above — empty means "no DB-granted permissions",
    # not "no access".
    permissions: frozenset[str] = frozenset()
    # True when the verified token's `amr` claim evidences an MFA factor
    # (TOTP/SMS). Derived from the token alone — no provider, no database.
    # Intended for gates that require step-up authentication rather than mere
    # group membership: a recovery or break-glass endpoint can demand that an
    # admin actually completed a second factor. Fail-closed — defaults to False,
    # so a token with no MFA marker simply cannot pass such a gate.
    mfa_authenticated: bool = False


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
        # Unknown kid and we can fetch remotely — JWKS may have rotated; bust
        # the cache and retry once.
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


def identity_from_token(
    credentials: HTTPAuthorizationCredentials,
) -> AuthenticatedUser:
    """Verify the Cognito JWT and map its claims to the caller's identity.

    Pure — no DB. The tenant_id is always 'default' in single-tenant deployments
    (ADR-0001). Roles come from the `cognito:groups` claim already present in the
    verified token (ADR-0004) — no extra round-trip. The claim is absent for a
    caller in no groups; it is a JSON array of group names when present.
    """
    return _user_from_claims(_verify_token(credentials.credentials))


# Cognito surfaces the factors used during authentication in the token's `amr`
# claim (an array). Treat any of these as proof a second factor was completed.
# Kept liberal but fail-closed: an unrecognised or absent marker just means no
# MFA. Lower-cased before matching.
_MFA_AMR_MARKERS = frozenset(
    {"mfa", "otp", "sms_mfa", "software_token_mfa", "sms", "totp", "swk", "hwk"}
)


def _amr_indicates_mfa(amr: object) -> bool:
    """True if the token's `amr` claim evidences an MFA factor. Accepts a list
    (Cognito's shape) or a space-delimited string; anything else → False."""
    if isinstance(amr, str):
        values = amr.split()
    elif isinstance(amr, (list, tuple)):
        values = [str(v) for v in amr]
    else:
        return False
    return any(v.lower() in _MFA_AMR_MARKERS for v in values)


def _user_from_claims(claims: dict) -> AuthenticatedUser:
    """Map verified claims to an identity. No DB — the provider-backed fields
    (`user_id`, `is_platform_admin`, `permissions`) stay at their fail-closed
    defaults until `require_auth` fills them in."""
    return AuthenticatedUser(
        sub=claims["sub"],
        email=claims.get("email", ""),
        username=claims.get("cognito:username", claims.get("username", "")),
        tenant_id="default",
        roles=list(claims.get("cognito:groups") or []),
        mfa_authenticated=_amr_indicates_mfa(claims.get("amr")),
    )


async def require_auth(
    credentials: HTTPAuthorizationCredentials = Security(_security),
    db: AsyncSession = Depends(identity_session),
) -> AuthenticatedUser:
    """
    FastAPI dependency: verify the Cognito JWT, enforce the user isn't
    deactivated, and return the caller's identity.

    Raises HTTP 401 if the token is missing/expired/invalid, or if the caller's
    identity record is marked inactive (issue #150). This is the single
    authorization seam every authenticated route flows through, so the is_active
    check applies everywhere — at the cost of one indexed lookup per request.

    Where that record lives is the deployment's business, not the Core's: every
    database-backed question here goes through the ADR-0012 `IdentityProvider`.
    This function must never name a table.

    Cognito's suspend flow (AdminDisableUser + AdminUserGlobalSignOut) revokes
    refresh tokens immediately, but an already-issued access token stays valid
    until it expires (~1h). Checking the deactivation flag on every request
    closes that window.
    """
    claims = _verify_token(credentials.credentials)
    user = _user_from_claims(claims)
    provider = get_identity_provider()

    identity = await provider.resolve(db, claims)
    if not identity.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account is deactivated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    is_platform_admin = settings.platform_admin_group in user.roles
    await provider.sync_platform_admin(db, identity.user_id, is_platform_admin)
    permissions = await provider.resolve_permissions(db, identity.user_id)

    return replace(
        user,
        user_id=identity.user_id,
        is_platform_admin=is_platform_admin,
        permissions=permissions,
    )
