from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..events import emit_event
from ..events.registry import USER_CREATED
from ..middleware.auth import AuthenticatedUser, require_auth
from ..models.user import User
from ..schemas.user import UserResponse

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/me", response_model=UserResponse)
async def get_current_user(
    caller: AuthenticatedUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
) -> User:
    """
    Returns the authenticated user's profile.

    On first call after login, creates the User record in the database
    using the identity from the verified Cognito JWT (upsert pattern).
    """
    result = await db.execute(
        select(User).where(
            User.cognito_sub == caller.sub,
            User.tenant_id == caller.tenant_id,
        )
    )
    user = result.scalar_one_or_none()

    if user is None:
        user = User(
            cognito_sub=caller.sub,
            email=caller.email,
            username=caller.username,
            tenant_id=caller.tenant_id,
            last_login_at=datetime.now(tz=UTC),
        )
        db.add(user)
        # id/is_active are populated by ORM-level defaults and created_at/updated_at
        # by server_default — none of them exist on the Python object until the
        # insert is actually flushed. Without this, response_model=UserResponse
        # fails validation on first login (id=None, created_at=None, ...) because
        # get_db only commits after the response has already been serialized.
        await db.flush()
        await db.refresh(user)
        # A user record now exists in Core — announce it so orchestration workflows
        # can react. Buffered and published after the request commits (ADR-0002,
        # #222), so a rolled-back login never emits. Fires once per user (only on
        # the create branch), after flush so user.id exists.
        emit_event(
            db,
            USER_CREATED,
            {
                "user_id": user.id,
                "cognito_sub": user.cognito_sub,
                "email": user.email,
                "username": user.username,
            },
            tenant_id=user.tenant_id,
        )
    else:
        user.last_login_at = datetime.now(tz=UTC)

    return user
