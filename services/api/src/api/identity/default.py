"""The identity provider a scaffolded instance starts with (ADR-0012).

Backed by the Core's own `public.users` table, so a fresh `biffo init` — which
has no business schema of any kind — authenticates out of the box, exactly as it
did before the seam existed.

A deployment that outgrows this replaces the provider; it does not patch
`middleware/auth.py`.
"""

from collections.abc import AsyncGenerator, Mapping, Sequence

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..database import get_db
from .base import WRITABLE_PROFILE_FIELDS, ResolvedIdentity, UserProfile


def _profile_of(user) -> UserProfile:
    """Flatten a `User` row (with `organization` loaded) into a `UserProfile`.

    `organization` must already be eager-loaded: reaching a lazy relationship
    from here would emit IO under an async session and raise `MissingGreenlet`,
    or worse, succeed during response serialisation on a session the caller has
    since closed. Every query below selectinloads it for that reason.
    """
    return UserProfile(
        id=str(user.id),
        tenant_id=user.tenant_id,
        created_at=user.created_at,
        updated_at=user.updated_at,
        email=user.email,
        username=user.username,
        is_active=bool(user.is_active),
        last_login_at=user.last_login_at,
        organization_id=user.organization_id,
        organization_name=user.organization.name if user.organization else None,
        job_role=user.job_role,
        address_line1=user.address_line1,
        address_line2=user.address_line2,
        city=user.city,
        region=user.region,
        postal_code=user.postal_code,
        country=user.country,
    )


class DefaultIdentityProvider:
    """Core-owned identity: one indexed lookup by `cognito_sub` per request."""

    def session(self) -> AsyncGenerator[AsyncSession]:
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

    async def resolve_permissions(self, db: AsyncSession, user_id: str | None) -> frozenset[str]:
        """Empty: the ADR-0004 model authorises from Cognito groups on the token,
        which `AuthenticatedUser.roles` already carries. No lookup needed."""
        return frozenset()

    # --- Profile surface ----------------------------------------------------
    # Behaviour-preserving: each method runs the query its former router ran. The
    # `User` import stays function-local throughout for the reason given in
    # `resolve` — a deployment that retired `public.users` must still be able to
    # import this package.

    async def list_profiles(self, db: AsyncSession, tenant_id: str) -> list[UserProfile]:
        from ..models.user import User  # pyright: ignore[reportMissingImports]

        result = await db.execute(
            select(User)
            .options(selectinload(User.organization))
            .where(User.tenant_id == tenant_id, User.is_active)
            .order_by(User.created_at)
        )
        return [_profile_of(u) for u in result.scalars().all()]

    async def get_profile_by_id(
        self, db: AsyncSession, tenant_id: str, user_id: str
    ) -> UserProfile | None:
        from ..models.user import User  # pyright: ignore[reportMissingImports]

        result = await db.execute(
            select(User)
            .options(selectinload(User.organization))
            .where(User.id == user_id, User.tenant_id == tenant_id)
        )
        user = result.scalar_one_or_none()
        return None if user is None else _profile_of(user)

    async def get_profile(self, db: AsyncSession, subject: str) -> UserProfile | None:
        from ..models.user import User  # pyright: ignore[reportMissingImports]

        result = await db.execute(
            select(User).options(selectinload(User.organization)).where(User.cognito_sub == subject)
        )
        user = result.scalar_one_or_none()
        return None if user is None else _profile_of(user)

    async def get_profiles(
        self, db: AsyncSession, subjects: Sequence[str]
    ) -> dict[str, UserProfile]:
        from ..models.user import User  # pyright: ignore[reportMissingImports]

        wanted = [s for s in subjects if s]
        if not wanted:
            return {}
        result = await db.execute(
            select(User)
            .options(selectinload(User.organization))
            .where(User.cognito_sub.in_(wanted))
        )
        return {u.cognito_sub: _profile_of(u) for u in result.scalars().all()}

    async def upsert_profile(
        self,
        db: AsyncSession,
        *,
        subject: str,
        tenant_id: str,
        email: str,
        username: str,
        fields: Mapping[str, object] | None = None,
    ) -> tuple[UserProfile, bool]:
        from ..models.user import User  # pyright: ignore[reportMissingImports]

        writes = dict(fields or {})
        unknown = set(writes) - WRITABLE_PROFILE_FIELDS
        if unknown:
            # Fail loudly rather than silently dropping a field the caller
            # believes it persisted, and never `setattr` an arbitrary name onto
            # the model — which is what the pre-seam admin router did.
            raise ValueError(f"not writable profile fields: {sorted(unknown)}")

        result = await db.execute(select(User).where(User.cognito_sub == subject))
        user = result.scalar_one_or_none()
        created = user is None

        if user is None:
            user = User(cognito_sub=subject, email=email, username=username, tenant_id=tenant_id)
            db.add(user)

        for field, value in writes.items():
            setattr(user, field, value)

        # `id`, `is_active` and the timestamps come from ORM and server defaults,
        # so they do not exist on a new Python object until the insert reaches the
        # database. Flushing here — rather than leaving it to the commit — is what
        # lets this return a fully-materialised profile, and is why the caller no
        # longer needs to know that `get_db` commits after serialisation.
        await db.flush()

        # Re-read with the relationship eager-loaded: `refresh` would not populate
        # `organization`, and reaching it lazily during serialisation is the
        # failure `_profile_of` documents.
        reloaded = await db.execute(
            select(User).options(selectinload(User.organization)).where(User.cognito_sub == subject)
        )
        return _profile_of(reloaded.scalar_one()), created

    async def set_active(self, db: AsyncSession, subject: str, active: bool) -> None:
        from ..models.user import User  # pyright: ignore[reportMissingImports]

        # No result inspection: zero rows updated is the ordinary case for a user
        # Cognito knows about who has never logged in, and suspending them must
        # still succeed.
        await db.execute(update(User).where(User.cognito_sub == subject).values(is_active=active))
