from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..identity import UserProfile, get_identity_provider
from ..middleware.auth import AuthenticatedUser, require_auth
from ..schemas.user import UserResponse

router = APIRouter(prefix="/users", tags=["users"])

# Reads go through the ADR-0012 provider rather than the Core user model. This
# module used to import that model at module scope and query it directly, which
# meant a deployment that legitimately retired the Core users table could not even
# *import* this router, let alone serve it — the API died at startup over a class
# the request path would never have used.
#
# The session is still `get_db`, deliberately. `IdentityProvider.session()` is
# documented as the session *identity resolution* runs on, for the RLS ordering
# problem described in `identity/base.py`; the profile surface has no such
# constraint, and routing it through `identity_session` instead would change the
# dependency every existing caller and test override binds to for no behavioural
# gain here.


@router.get("", response_model=list[UserResponse])
async def list_users(
    caller: AuthenticatedUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
) -> list[UserProfile]:
    """List all users within the caller's tenant."""
    return await get_identity_provider().list_profiles(db, caller.tenant_id)


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: str,
    caller: AuthenticatedUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
) -> UserProfile:
    """Fetch a single user by ID, scoped to the caller's tenant."""
    profile = await get_identity_provider().get_profile_by_id(db, caller.tenant_id, user_id)
    if profile is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return profile
