"""`GET /api/v1/whoami` — the contract the template-owned portal login page reads.

The portal called this route for two days in an instance whose API never served
it. FastAPI answered 404, the login page could not resolve a destination, and it
returned the user to the sign-in form — which reads, from the outside, exactly
like a rejected password. These tests pin both halves: the shape the frontend
destructures, and the registration order that keeps a product domain's richer
implementation winning.
"""

import ast
from pathlib import Path

import pytest
from api import main as api_main
from api.identity import DefaultIdentityProvider, get_identity_provider, set_identity_provider
from api.middleware.auth import AuthenticatedUser
from api.permissions import build_permissions_registry
from api.routers.whoami import whoami


def _caller(**overrides) -> AuthenticatedUser:
    defaults = {
        "sub": "sub-123",
        "email": "someone@example.com",
        "username": "someone",
        "tenant_id": "default",
    }
    return AuthenticatedUser(**{**defaults, **overrides})


async def test_returns_every_field_the_portal_destructures():
    """`WhoamiResponse` in login-routing.ts reads exactly these keys.

    A missing key is not a type error at runtime — it is `undefined`, which
    `resolveDestination` silently treats as "no access". So assert on the key
    set, not just on the values.
    """
    result = await whoami(caller=_caller())

    assert set(result) >= {
        "sub",
        "email",
        "username",
        "user_id",
        "is_platform_admin",
        "permissions",
        "roles",
        "marketplace_role",
    }


async def test_reports_identity_from_the_verified_token():
    result = await whoami(caller=_caller(user_id="user-42"))

    assert result["sub"] == "sub-123"
    assert result["email"] == "someone@example.com"
    assert result["username"] == "someone"
    assert result["user_id"] == "user-42"


async def test_platform_admin_flag_is_mirrored_not_inferred():
    assert (await whoami(caller=_caller()))["is_platform_admin"] is False
    assert (await whoami(caller=_caller(is_platform_admin=True)))["is_platform_admin"] is True


async def test_groups_and_permissions_are_sorted_for_a_stable_contract():
    result = await whoami(
        caller=_caller(roles=["editor", "admin"], permissions=frozenset({"b.read", "a.write"}))
    )

    assert result["groups"] == ["admin", "editor"]
    assert result["permissions"] == ["a.write", "b.read"]


async def test_a_caller_in_no_groups_gets_empties_rather_than_an_error():
    """The no-access path must still resolve — routing rule 7 depends on it."""
    result = await whoami(caller=_caller())

    assert result["groups"] == []
    assert result["permissions"] == []


async def test_roles_and_marketplace_role_are_honest_empties_in_core():
    """Core has no scoped-role or marketplace model, and says so.

    Not placeholders: an instance that HAS those concepts serves its own whoami
    from a product domain (see the ordering test below), so core inventing a
    shape here would be a second, drifting copy of a model it does not hold.
    """
    result = await whoami(caller=_caller(is_platform_admin=True))

    assert result["roles"] == []
    assert result["marketplace_role"] is None


# --- unreachable_permission_codes (#1606's diagnostic requirement) ---------


@pytest.fixture(autouse=True)
def _restore_identity_provider():
    """Process-global state — see test_auth_is_active.py's identical fixture."""
    original = get_identity_provider()
    yield
    set_identity_provider(original)


def _registry_with_unreachable_code():
    manifest = {
        "name": "crm",
        "version": "1.0.0",
        "tables": [
            {
                "name": "leads",
                "permissions": {"read": {"allowed": True, "permission_code": "crm.lead.read"}},
            }
        ],
    }
    return build_permissions_registry([manifest], core_models=[])


async def test_non_admin_never_gets_the_instance_diagnostic():
    """This one field is deliberately not caller-scoped — see the module
    docstring — so it must not leak instance-wide plugin metadata to every
    authenticated caller, only a platform admin."""
    set_identity_provider(DefaultIdentityProvider())
    result = await whoami(caller=_caller(is_platform_admin=False))

    assert "unreachable_permission_codes" not in result
    assert "unreachable_permission_codes_checked" not in result
    assert "unreachable_permission_codes_provider" not in result


async def test_admin_sees_an_unreachable_code_by_name(monkeypatch):
    """Fail-first for #1606's diagnostic: one call (GET /whoami) is enough to
    learn a declared permission_code is unreachable, without reading logs.
    State 2: checked, found."""
    set_identity_provider(DefaultIdentityProvider())
    monkeypatch.setattr(
        "api.routers.whoami.get_permissions_registry",
        lambda: _registry_with_unreachable_code(),
    )

    result = await whoami(caller=_caller(is_platform_admin=True))

    assert result["unreachable_permission_codes"] == [
        {"table": "leads", "operation": "read", "permission_code": "crm.lead.read"}
    ]
    assert result["unreachable_permission_codes_checked"] is True
    assert result["unreachable_permission_codes_provider"] == "DefaultIdentityProvider"


async def test_admin_sees_an_empty_list_when_nothing_is_unreachable(monkeypatch):
    """State 1: checked, clean."""
    set_identity_provider(DefaultIdentityProvider())
    monkeypatch.setattr("api.routers.whoami.get_permissions_registry", lambda: {})

    result = await whoami(caller=_caller(is_platform_admin=True))

    assert result["unreachable_permission_codes"] == []
    assert result["unreachable_permission_codes_checked"] is True


class _CustomProvider:
    """A plausible custom-RBAC provider — the realistic production shape this
    diagnostic exists for (#1606's own worked example is the trivial default
    provider case; a custom provider is the interesting one). Genuinely grants
    a code other than the one the manifest below declares, so `crm.lead.read`
    really is unreachable on this instance — Core just cannot prove it without
    a database round trip it deliberately never makes.
    """

    def session(self):
        raise NotImplementedError

    async def resolve(self, db, claims):
        raise NotImplementedError

    async def sync_platform_admin(self, db, user_id, is_member):
        return None

    async def resolve_permissions(self, db, user_id):
        return frozenset({"other.code"})


async def test_custom_provider_reports_could_not_check_never_a_false_clean(monkeypatch):
    """#1636, fail-first, executed exactly by the reproduction route the issue
    used: platform admin, real `whoami` handler, a custom RBAC provider that
    genuinely never grants the declared code.

    Pre-fix this asserted `result["unreachable_permission_codes"] == []` — a
    false clean bill of health indistinguishable from a healthy deployment
    (proven by running the unmodified pre-change code: it returned exactly
    `{'unreachable_permission_codes': []}`). The fix must never render this as
    state 1: `unreachable_permission_codes` is `None`, not `[]`, and
    `_checked` is `False` with the provider named.
    """
    set_identity_provider(_CustomProvider())  # type: ignore[arg-type]
    monkeypatch.setattr(
        "api.routers.whoami.get_permissions_registry",
        lambda: _registry_with_unreachable_code(),
    )

    result = await whoami(caller=_caller(is_platform_admin=True))

    assert result["unreachable_permission_codes"] is None
    assert result["unreachable_permission_codes"] != []
    assert result["unreachable_permission_codes_checked"] is False
    assert result["unreachable_permission_codes_provider"] == "_CustomProvider"


def test_route_is_actually_mounted_at_the_path_the_portal_calls():
    """The 404 that started this was a route that existed nowhere but a docstring.

    Asserted against the assembled OpenAPI schema rather than `app.routes`:
    this FastAPI version keeps included routers as unflattened `_IncludedRouter`
    entries, so `app.routes` holds only the three docs routes and a membership
    check over it passes vacuously for every path in the API. The schema is what
    actually resolves the includes.
    """
    assert "/api/v1/whoami" in api_main.app.openapi()["paths"]


def test_whoami_is_registered_after_the_domain_router():
    """Load-bearing: Starlette takes the FIRST matching route.

    An instance with real scoped roles serves `/whoami` from its product domain
    (`api/domains/<name>/whoami.py`), mounted by `build_domain_router()`. If
    core's fallback were registered before that, it would shadow the richer one
    with core's honest empties — and since `resolveDestination` reads `roles` to
    pick a destination, every scoped user would be routed to no-access. That is
    a worse failure than the 404 this router exists to fix, because it fails
    silently and looks like a permissions problem.

    Read from main.py's source rather than hardcoded, so reordering the includes
    fails this test instead of quietly re-arming the trap.
    """
    tree = ast.parse(Path(api_main.__file__).read_text(encoding="utf-8"))

    domain_router_line = None
    whoami_include_line = None
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Name) and node.func.id == "build_domain_router":
            domain_router_line = node.lineno
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "include_router"
            and node.args
            and isinstance(node.args[0], ast.Attribute)
            and node.args[0].attr == "router"
            and isinstance(node.args[0].value, ast.Name)
            and node.args[0].value.id == "whoami"
        ):
            whoami_include_line = node.lineno

    assert domain_router_line is not None, "main.py no longer calls build_domain_router()"
    assert whoami_include_line is not None, "main.py no longer includes whoami.router"
    assert whoami_include_line > domain_router_line, (
        "core's whoami router must be included AFTER build_domain_router(), or it "
        "shadows a product domain's richer /whoami and routes every scoped user "
        "to no-access"
    )
