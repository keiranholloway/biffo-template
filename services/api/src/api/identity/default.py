"""The identity provider a scaffolded instance starts with (ADR-0012).

Backed by the Core's own `public.users` table, so a fresh `biffo init` — which
has no business schema of any kind — authenticates out of the box, exactly as it
did before the seam existed.

A deployment that outgrows this replaces the provider; it does not patch
`middleware/auth.py`.
"""

from collections.abc import AsyncGenerator

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from .base import ResolvedIdentity


class DefaultIdentityProvider:
    """Core-owned identity: one indexed lookup by `cognito_sub` per request."""

    def session(self) -> AsyncGenerator[AsyncSession, None]:
        # No RLS in the base template, so the ordinary request session is right.
        return get_db()

    async def resolve(self, db: AsyncSession, claims: dict) -> ResolvedIdentity:
        """Look up the caller's row by `cognito_sub`.

        Selects id and is_active together — the pre-seam code read only
        is_active, and fetching both keeps this at the same single indexed
        lookup rather than adding a second query for the id.

        No row means provisioned-but-never-logged-in: active, with no id yet. The
        row is created by the login endpoint (`routers/auth.py`), not here —
        `require_auth` runs on every authenticated request and must not write.

        The `User` model is imported here rather than at module scope because a
        deployment that overrides this provider may have deleted it outright —
        retiring `public.users` is the whole point of ADR-0012. A module-level
        import would make merely *importing* the identity package fail on such a
        deployment, taking the API down at startup over a class it never uses.
        """
        # pyright: ignore[reportMissingImports] — the module is genuinely absent
        # on a deployment that retired it, which ADR-0012 explicitly supports.
        # Unsuppressed, type-checking fails there on a provider that deployment
        # never calls.
        from ..models.user import User  # pyright: ignore[reportMissingImports]

        result = await db.execute(
            select(User.id, User.is_active).where(User.cognito_sub == claims["sub"])
        )
        row = result.one_or_none()
        if row is None:
            return ResolvedIdentity(user_id=None, is_active=True)
        return ResolvedIdentity(user_id=str(row.id), is_active=bool(row.is_active))

    async def sync_platform_admin(
        self, db: AsyncSession, user_id: str | None, is_member: bool
    ) -> None:
        """No-op: there is no platform-admin table in the base template.

        Platform-admin status is read straight off the token's `cognito:groups`
        claim, so there is nothing to mirror. Deployments whose RLS policies read
        a table instead reconcile it here.
        """
        return None

    async def resolve_permissions(
        self, db: AsyncSession, user_id: str | None
    ) -> frozenset[str]:
        """Empty: the ADR-0004 model authorises from Cognito groups on the token,
        which `AuthenticatedUser.roles` already carries. No lookup needed."""
        return frozenset()
