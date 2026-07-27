"""One caller, however they authenticated (#621).

Core has two *transports* for an authenticated request, and that part is forced
by AWS, not by us:

- A human's browser sends the Cognito token as ``Authorization: Bearer <jwt>``.
- A service's Lambda SigV4-signs the request, which **claims** the
  ``Authorization`` header for the AWS signature — so the user it acts for rides
  ``X-Biffo-User-Token`` instead (``middleware/forwarded_user``).

What was *not* forced was letting that split grow into two parallel
authorization stacks. It did, and they drifted: the ``is_active`` deactivation
gate (#150) was enforced on the bearer path and silently missing from the
forwarded one, so a suspended user's unexpired token kept working through every
plugin-forwarded route. #655 fixed that instance by extracting
``authenticated_identity``; this module removes the conditions that produced it.

:class:`Principal` is the single answer to "who is calling": always a verified
user, plus the service that carried the request when there was one. A route
asks for a principal and gets the same guarantees regardless of which header the
token arrived in.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from ..identity import identity_session
from .auth import AuthenticatedUser, authenticated_identity, claims_from_token
from .forwarded_user import FORWARDED_USER_HEADER
from .service_auth import ServicePrincipal, optional_service_principal

#: ``auto_error=False`` so a missing/non-Bearer ``Authorization`` yields ``None``
#: instead of a 401 raised before we can look at the forwarded header. A SigV4
#: signature lands here as a non-Bearer scheme and is correctly ignored.
_optional_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Principal:
    """The verified caller: a user, and the service acting for them if any.

    ``user`` is never ``None`` — every route this resolves for acts for some
    human, whether they called directly or a plugin forwarded their token. A
    background actor with no user at all is a different shape and still uses
    ``require_service_principal`` on its own.
    """

    user: AuthenticatedUser
    service: ServicePrincipal | None = None

    @property
    def is_service_call(self) -> bool:
        """Whether a verified service carried this request on the user's behalf."""
        return self.service is not None


async def require_principal(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_optional_bearer),
    forwarded_token: str | None = Header(default=None, alias=FORWARDED_USER_HEADER),
    db: AsyncSession = Depends(identity_session),
) -> Principal:
    """Resolve the caller from whichever transport they used.

    The forwarded header wins when present: its presence means the request was
    SigV4-signed, so ``Authorization`` holds a signature rather than a usable
    JWT. Otherwise the bearer token is the user's own.

    Whichever header carried it, the token is verified and then run through
    ``authenticated_identity`` — so the deactivation gate, platform-admin sync
    and permission resolution apply identically. That is the property this
    module exists to make structural rather than remembered.

    401 when no user token is present at all, or when it fails verification;
    403 when a service principal is present but not allowlisted (raised by
    ``optional_service_principal``, which fails closed).
    """
    service = await optional_service_principal(request)

    token = forwarded_token or (credentials.credentials if credentials else None)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    claims = claims_from_token(HTTPAuthorizationCredentials(scheme="Bearer", credentials=token))
    return Principal(user=await authenticated_identity(claims, db), service=service)
