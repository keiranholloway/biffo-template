"""Identity seam wiring (ADR-0012).

The Core holds one provider. A deployment overrides it once, at import time,
before the app serves traffic — `set_identity_provider(TabsiiIdentityProvider())`
in the API's startup path — and never touches `middleware/auth.py`.
"""

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession

from .base import IdentityProvider, ResolvedIdentity
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
    "DefaultIdentityProvider",
    "IdentityProvider",
    "ResolvedIdentity",
    "get_identity_provider",
    "identity_session",
    "set_identity_provider",
]
