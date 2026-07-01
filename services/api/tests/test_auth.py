"""Regression test for the auth.py get_current_user first-login response bug."""

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from api.middleware.auth import AuthenticatedUser
from api.models.base import Base
from api.models.user import User  # noqa: F401 — registers the users table on Base.metadata
from api.routers.auth import get_current_user
from api.schemas.user import UserResponse


@pytest.fixture
async def db_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        yield session

    await engine.dispose()


async def test_first_login_creates_user_with_populated_response_fields(db_session):
    """Regression: get_current_user used to return a User with id/created_at/
    updated_at/is_active all None on first login, because db.add() alone never
    flushes to the database — FastAPI's response_model=UserResponse validation
    failed with a 500 before get_db's post-yield commit ever ran.
    """
    caller = AuthenticatedUser(
        sub="test-sub-123",
        email="new-user@example.com",
        username="newuser",
        tenant_id="default",
    )

    user = await get_current_user(caller=caller, db=db_session)

    # This is exactly what response_model=UserResponse validates on the way out —
    # it must not raise, and every field must be populated (not None).
    response = UserResponse.model_validate(user)
    assert response.email == "new-user@example.com"
    assert response.is_active is True
    assert user.id is not None
    assert user.created_at is not None
    assert user.updated_at is not None


async def test_returning_user_login_updates_last_login_at(db_session):
    caller = AuthenticatedUser(
        sub="test-sub-456",
        email="returning@example.com",
        username="returninguser",
        tenant_id="default",
    )

    first = await get_current_user(caller=caller, db=db_session)
    await db_session.commit()

    second = await get_current_user(caller=caller, db=db_session)

    assert second.id == first.id
    assert second.last_login_at is not None
