"""Identity seam wiring (ADR-0012).

The Core holds one provider. A deployment overrides it once, at import time,
before the app serves traffic, and never touches `middleware/auth.py`.

**Where that call belongs: your domain package's `__init__.py`** —
`set_identity_provider(MyIdentityProvider())` in `domains/<name>/__init__.py`,
with the provider module beside it in `domains/<name>/`. That directory is
user-owned (`core-manifest.json`); this package is not, so a provider kept here
needs a per-commit `Core-Divergence` trailer to touch. `build_domain_router()`
imports every domain at module scope before the handler is built, and
`lifespan="off"` means import time is the only registration window — see
`domains/README.md` and `tests/test_identity_provider_registration.py`, which
pins that ordering.
"""

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession

from .base import WRITABLE_PROFILE_FIELDS, IdentityProvider, ResolvedIdentity, UserProfile
from .default import DefaultIdentityProvider

_provider: IdentityProvider = DefaultIdentityProvider()


def get_identity_provider() -> IdentityProvider:
    """The active provider. Defaults to the Core-owned `public.users` one."""
    return _provider


def set_identity_provider(provider: IdentityProvider) -> None:
    """Install a deployment's provider, replacing the default.

    Call once during startup. Swapping it while requests are in flight would let
    two requests resolve identity against different backing stores.
    """
    global _provider
    _provider = provider


async def identity_session() -> AsyncGenerator[AsyncSession]:
    """FastAPI dependency yielding the session identity resolution runs on.

    A fixed dependency that dispatches to the provider at request time, rather
    than `Depends(get_db)` baked into `require_auth`'s signature at import time —
    which is exactly what a provider needing an RLS-bypass session could not
    override without forking the auth path.
    """
    async for session in get_identity_provider().session():
        yield session


__all__ = [
    "WRITABLE_PROFILE_FIELDS",
    "DefaultIdentityProvider",
    "IdentityProvider",
    "ResolvedIdentity",
    "UserProfile",
    "get_identity_provider",
    "identity_session",
    "set_identity_provider",
]
