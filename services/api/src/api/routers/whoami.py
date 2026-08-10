"""The caller's effective authorization context.

`GET /api/v1/whoami` is the contract the portal's login page consumes to decide
where an authenticated caller lands (`apps/portal/src/lib/login-routing.ts`).
Every sign-in on every surface calls it, so it is on the critical path of
getting into the product at all.

## Why this exists in core, when the rich implementation is a product's

The portal is template-owned and distributed to every instance. It began
calling `/api/v1/whoami` while the only implementation of that route lived in
one instance's product domain (`api/domains/tabsii/whoami.py`), so every other
instance shipped a login page calling an endpoint its own API did not serve.
FastAPI answered 404, the login page could not resolve a destination, and the
user was returned to the form — indistinguishable, from the outside, from a
rejected password. biffo-platform's dev portal was unusable this way for two
days and the account it locked out was the estate owner's.

A caller-side fallback alone would not have fixed it: the portal cannot invent
an identity the API declined to describe. The contract the shared frontend
depends on has to exist in the shared backend.

## What core can honestly answer

Everything here comes from the verified JWT and the ADR-0012 identity provider,
both of which `require_auth` has already resolved — there is no query to make.
Core has no role-assignment or marketplace model, so:

- `roles` is always `[]` — scoped role assignments (tenant/brand/region/unit)
  are a product concept, not a core one.
- `marketplace_role` is always `None` for the same reason.

Those are honest empties, not placeholders to fill in later. Under the ADR-0004
default model authorisation comes from `groups` (the `cognito:groups` claim),
which is reported in full, and `is_platform_admin` collapses the platform-admin
group to the boolean the routing rules read.

The consequence for routing is deliberate: a core deployment sends `admin`
group members to the admin surface (rule 2) and everyone else to no-access
(rule 7), because in a deployment with no product roles there is genuinely
nowhere else for a non-admin to go.

## An instance that serves its own whoami keeps it

This router is registered **after** the domain router in `main.py`, so a
product domain declaring `GET /whoami` wins the path and this never runs. That
ordering is load-bearing and asserted in `tests/test_whoami.py` —
registering it earlier would silently shadow a richer implementation with these
empties, turning every scoped role into "no access".
"""

from fastapi import APIRouter, Depends

from ..middleware.auth import AuthenticatedUser, require_auth

router = APIRouter(tags=["auth"])


@router.get("/whoami")
async def whoami(caller: AuthenticatedUser = Depends(require_auth)) -> dict:
    """Return the authenticated caller's identity and effective authorization."""
    return {
        "sub": caller.sub,
        "email": caller.email,
        "username": caller.username,
        "user_id": caller.user_id,
        "is_platform_admin": caller.is_platform_admin,
        # The caller's raw Cognito groups. `is_platform_admin` above collapses
        # one group to a boolean; `admin` is a different group serving a
        # different purpose, and a client that cannot see it cannot gate on it.
        #
        # Advisory, like `permissions` beside it: the authoritative check is
        # always the real call, which re-reads the groups from the token. A
        # client rendering a control on this alone is showing an affordance,
        # not granting anything.
        "groups": sorted(caller.roles),
        "permissions": sorted(caller.permissions),
        # Always empty in core — see the module docstring. An instance with a
        # role model serves its own whoami from its product domain.
        "roles": [],
        "marketplace_role": None,
    }
