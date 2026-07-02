"""Tests for PermissionChecker.check() — the RBAC plugin's own
check_permission logic (not expressible as generic CRUD; see the module
docstring in src/rbac/permissions.py for why)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fakes import FakeCoreApi
from rbac.permissions import PermissionChecker


def _seed(
    fake: FakeCoreApi,
    *,
    user_id: str = "user-1",
    resource: str = "documents",
    action: str = "read",
    effect: str | None = "allow",
    expires_at: str | None = None,
) -> None:
    fake.tables["roles"].append({"id": "role-1", "name": "viewer"})
    fake.tables["permissions"].append(
        {"id": "perm-1", "resource": resource, "action": action, "effect": effect}
    )
    fake.tables["role-permissions"].append(
        {"id": "rp-1", "role_id": "role-1", "permission_id": "perm-1"}
    )
    fake.tables["assignments"].append(
        {
            "id": "ur-1",
            "user_id": user_id,
            "role_id": "role-1",
            "expires_at": expires_at,
        }
    )


class TestCheckGrantsAndDenies:
    async def test_returns_true_when_permission_granted(self) -> None:
        fake = FakeCoreApi()
        _seed(fake)
        checker = PermissionChecker(fake.client())

        assert await checker.check("user-1", "documents", "read") is True

    async def test_returns_false_when_user_has_no_assignment(self) -> None:
        fake = FakeCoreApi()
        _seed(fake)
        checker = PermissionChecker(fake.client())

        assert await checker.check("someone-else", "documents", "read") is False

    async def test_returns_false_when_resource_action_does_not_match(self) -> None:
        fake = FakeCoreApi()
        _seed(fake)
        checker = PermissionChecker(fake.client())

        assert await checker.check("user-1", "documents", "write") is False

    async def test_returns_false_when_role_has_no_permissions(self) -> None:
        fake = FakeCoreApi()
        fake.tables["roles"].append({"id": "role-1", "name": "viewer"})
        fake.tables["assignments"].append(
            {"id": "ur-1", "user_id": "user-1", "role_id": "role-1"}
        )
        checker = PermissionChecker(fake.client())

        assert await checker.check("user-1", "documents", "read") is False

    async def test_null_effect_defaults_to_allow(self) -> None:
        fake = FakeCoreApi()
        _seed(fake, effect=None)
        checker = PermissionChecker(fake.client())

        assert await checker.check("user-1", "documents", "read") is True

    async def test_deny_effect_returns_false(self) -> None:
        fake = FakeCoreApi()
        _seed(fake, effect="deny")
        checker = PermissionChecker(fake.client())

        assert await checker.check("user-1", "documents", "read") is False

    async def test_deny_takes_precedence_over_allow(self) -> None:
        fake = FakeCoreApi()
        _seed(fake)
        # A second role grants the same permission with effect=deny.
        fake.tables["roles"].append({"id": "role-2", "name": "restricted"})
        fake.tables["permissions"].append(
            {
                "id": "perm-2",
                "resource": "documents",
                "action": "read",
                "effect": "deny",
            }
        )
        fake.tables["role-permissions"].append(
            {"id": "rp-2", "role_id": "role-2", "permission_id": "perm-2"}
        )
        fake.tables["assignments"].append(
            {"id": "ur-2", "user_id": "user-1", "role_id": "role-2"}
        )
        checker = PermissionChecker(fake.client())

        assert await checker.check("user-1", "documents", "read") is False


class TestAssignmentExpiry:
    async def test_expired_assignment_denies(self) -> None:
        fake = FakeCoreApi()
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        _seed(fake, expires_at=past)
        checker = PermissionChecker(fake.client())

        assert await checker.check("user-1", "documents", "read") is False

    async def test_future_expiry_still_active(self) -> None:
        fake = FakeCoreApi()
        future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        _seed(fake, expires_at=future)
        checker = PermissionChecker(fake.client())

        assert await checker.check("user-1", "documents", "read") is True

    async def test_no_expiry_never_expires(self) -> None:
        fake = FakeCoreApi()
        _seed(fake, expires_at=None)
        checker = PermissionChecker(fake.client())

        assert await checker.check("user-1", "documents", "read") is True

    async def test_unparseable_expiry_fails_closed(self) -> None:
        fake = FakeCoreApi()
        _seed(fake, expires_at="not-a-date")
        checker = PermissionChecker(fake.client())

        assert await checker.check("user-1", "documents", "read") is False


class TestCaching:
    async def test_second_identical_check_is_served_from_cache(self) -> None:
        fake = FakeCoreApi()
        _seed(fake)
        checker = PermissionChecker(fake.client())

        await checker.check("user-1", "documents", "read")
        calls_after_first = len(fake.request_log)
        await checker.check("user-1", "documents", "read")

        assert len(fake.request_log) == calls_after_first

    async def test_different_args_are_not_cached_together(self) -> None:
        fake = FakeCoreApi()
        _seed(fake)
        checker = PermissionChecker(fake.client())

        await checker.check("user-1", "documents", "read")
        calls_after_first = len(fake.request_log)
        await checker.check("user-1", "documents", "write")

        assert len(fake.request_log) > calls_after_first

    async def test_expired_cache_entry_is_recomputed(self) -> None:
        fake = FakeCoreApi()
        _seed(fake)
        checker = PermissionChecker(fake.client(), ttl_seconds=0.0)

        await checker.check("user-1", "documents", "read")
        calls_after_first = len(fake.request_log)
        await checker.check("user-1", "documents", "read")

        assert len(fake.request_log) > calls_after_first

    async def test_invalidate_clears_cache(self) -> None:
        fake = FakeCoreApi()
        _seed(fake)
        checker = PermissionChecker(fake.client())

        await checker.check("user-1", "documents", "read")
        calls_after_first = len(fake.request_log)
        checker.invalidate()
        await checker.check("user-1", "documents", "read")

        assert len(fake.request_log) > calls_after_first
