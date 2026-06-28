from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..middleware.auth import AuthenticatedUser, require_auth
from ..models.user import User
from ..schemas.user import UserResponse

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserResponse])
async def list_users(
    caller: AuthenticatedUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
) -> list[User]:
    """List all users within the caller's tenant."""
    result = await db.execute(
        select(User)
        .where(User.tenant_id == caller.tenant_id, User.is_active == True)  # noqa: E712
        .order_by(User.created_at)
    )
    return list(result.scalars().all())


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: str,
    caller: AuthenticatedUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Fetch a single user by ID, scoped to the caller's tenant."""
    result = await db.execute(
        select(User).where(User.id == user_id, User.tenant_id == caller.tenant_id)
    )
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )
    return user
