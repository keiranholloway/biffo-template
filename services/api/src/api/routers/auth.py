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
    else:
        user.last_login_at = datetime.now(tz=timezone.utc)

    return user
