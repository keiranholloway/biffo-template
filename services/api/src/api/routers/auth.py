from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
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
            last_login_at=datetime.now(tz=timezone.utc),
        )
        db.add(user)
        # id/is_active are populated by ORM-level defaults and created_at/updated_at
        # by server_default — none of them exist on the Python object until the
        # insert is actually flushed. Without this, response_model=UserResponse
        # fails validation on first login (id=None, created_at=None, ...) because
        # get_db only commits after the response has already been serialized.
        await db.flush()
        await db.refresh(user)
    else:
        user.last_login_at = datetime.now(tz=timezone.utc)

    return user
