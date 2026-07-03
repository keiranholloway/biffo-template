from fastapi import APIRouter, Depends

from ..middleware.auth import AuthenticatedUser, require_auth

router = APIRouter()


@router.get("/whoami")
async def whoami(caller: AuthenticatedUser = Depends(require_auth)) -> dict:
    """
    Proves the shared-Cognito-session SSO (ADR-0007) actually works: the
    frontend calls this immediately after finding a session, and only
    renders "Hello <username>" once this independently-verified response
    comes back — never trusting a client-side JWT decode for display.
    """
    return {"username": caller.username or caller.email or caller.sub}


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}
