"""Unit tests for the scoped-authorization registry (docs/implementation/
0003-hierarchy-scoped-workflows, Phase 3)."""

from __future__ import annotations

from typing import Any, cast

import pytest
from api import orchestration_authz as authz
from api.middleware.auth import AuthenticatedUser
from sqlalchemy.ext.asyncio import AsyncSession

_DB = cast(AsyncSession, None)


def _caller(roles: list[str] | None = None) -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="sub",
        email="a@b.com",
        username="a",
        tenant_id="default",
        roles=roles or [],
    )


@pytest.fixture(autouse=True)
def _reset_registry():
    saved = authz._authorizer  # noqa: SLF001
    yield
    authz._authorizer = saved  # noqa: SLF001


async def test_default_authorizer_fails_closed_for_unscoped_and_scoped():
    assert await authz.authorize_workflow_scope(_caller(), _DB, None) is False
    assert (
        await authz.authorize_workflow_scope(_caller(), _DB, {"level": "brand", "id": "b1"})
        is False
    )


async def test_register_workflow_scope_authorizer_is_idempotent_last_wins():
    async def authorizer_a(caller: Any, db: Any, scope: Any) -> bool:
        return False

    async def authorizer_b(caller: Any, db: Any, scope: Any) -> bool:
        return True

    authz.register_workflow_scope_authorizer(authorizer_a)
    authz.register_workflow_scope_authorizer(authorizer_b)

    assert await authz.authorize_workflow_scope(_caller(), _DB, None) is True


async def test_registered_authorizer_receives_the_exact_scope_passed_through():
    seen: list[dict[str, Any] | None] = []

    async def authorizer(caller: Any, db: Any, scope: dict[str, Any] | None) -> bool:
        seen.append(scope)
        return True

    authz.register_workflow_scope_authorizer(authorizer)

    await authz.authorize_workflow_scope(_caller(), _DB, {"level": "region", "id": "r1"})
    await authz.authorize_workflow_scope(_caller(), _DB, None)

    assert seen == [{"level": "region", "id": "r1"}, None]
