"""Resolving a founder forwarded on behalf of a plugin (ADR-0017 §3/§5).

A plugin's own Lambda calls Core's internal (SigV4) endpoints *on behalf of a
founder*. Core does not trust the plugin's word for who that founder is: the
founder's Cognito access token is forwarded in the ``X-Biffo-User-Token`` header
and **re-verified here** with Core's own token→identity mapping, so Core — not the
plugin — is the authority on the user's identity (and the owner of any data the
call touches). Shared by the internal chat endpoint (§3) and the owner-scoped data
router (§5).
"""

from __future__ import annotations

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession

from ..identity import identity_session
from .auth import AuthenticatedUser, authenticated_identity, claims_from_token

#: The header the plugin forwards the founder's Cognito access token in. Distinct
#: from ``Authorization`` (which carries the caller's SigV4 signature on these routes).
FORWARDED_USER_HEADER = "X-Biffo-User-Token"


async def require_forwarded_user(
    forwarded_token: str | None = Header(default=None, alias=FORWARDED_USER_HEADER),
    db: AsyncSession = Depends(identity_session),
) -> AuthenticatedUser:
    """Resolve the founder from the forwarded, re-verified Cognito token.

    A 401 when the header is absent, the token fails verification, or the account
    has been deactivated — Core is the authority on the user's identity, so a
    plugin cannot act for a founder without a token that verifies here *and* an
    account still allowed in.

    That last clause used to be missing: this path verified the token and
    returned, skipping the deactivation gate `require_auth` applies, so a
    suspended user's unexpired access token still worked through every
    plugin-forwarded route (#621). Both paths now share
    `authenticated_identity`, at the cost of the same one indexed lookup
    `require_auth` already pays.
    """
    if not forwarded_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"A forwarded user token ({FORWARDED_USER_HEADER}) is required.",
        )
    claims = claims_from_token(
        HTTPAuthorizationCredentials(scheme="Bearer", credentials=forwarded_token)
    )
    return await authenticated_identity(claims, db)
