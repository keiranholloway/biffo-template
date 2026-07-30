from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..events import emit_event
from ..events.registry import USER_CREATED
from ..identity import UserProfile, get_identity_provider
from ..middleware.auth import AuthenticatedUser, require_auth
from ..schemas.user import UserResponse

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/me", response_model=UserResponse)
async def get_current_user(
    caller: AuthenticatedUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
) -> UserProfile:
    """
    Returns the authenticated user's profile.

    On first call after login, creates the record via the ADR-0012 identity
    provider using the identity from the verified Cognito JWT (upsert pattern).
    Which store that record lands in is the deployment's choice — this endpoint
    no longer assumes the Core users table.
    """
    profile, created = await get_identity_provider().upsert_profile(
        db,
        subject=caller.sub,
        tenant_id=caller.tenant_id,
        email=caller.email,
        username=caller.username,
        fields={"last_login_at": datetime.now(tz=UTC)},
    )

    if created:
        # A user record now exists in Core — announce it so orchestration workflows
        # can react. Buffered and published after the request commits (ADR-0002,
        # #222), so a rolled-back login never emits. Fires once per user.
        #
        # Emitted here rather than inside the provider on purpose: `emit_event`
        # buffers onto this session's `info` and `get_db` publishes from it after
        # commit, whereas a provider is free to run on its own RLS-bypass session.
        # A provider that emitted this itself would buffer it onto a session
        # nothing publishes, and the event would vanish silently.
        emit_event(
            db,
            USER_CREATED,
            {
                "user_id": profile.id,
                "cognito_sub": caller.sub,
                "email": profile.email,
                "username": profile.username,
            },
            tenant_id=profile.tenant_id,
        )

    return profile
