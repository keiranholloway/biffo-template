"""The ADR-0012 identity seam.

Biffo Core does not assume it owns the identity record. `middleware/auth.py`
verifies the Cognito JWT — that part is core and provider-independent — then asks
the configured `IdentityProvider` every question that needs the database.

A deployment whose users live somewhere other than `public.users` (the tabsii
instance sources them from its ADR-0005 DDL-imported business schema) implements
this protocol instead of forking the authentication path.

This is an in-core extension point, not an ADR-0003 installable plugin. ADR-0011
stands: authorization is always present. The seam decides *where the identity
record lives*, never *whether* authorization runs.
"""

from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class ResolvedIdentity:
    """What a provider knows about the caller after one database round-trip.

    `user_id` is the deployment's canonical identifier for the caller, or None
    when no record exists yet — provisioned-but-never-logged-in, or a deployment
    that keeps no local row at all. `is_active` is False only for a record that
    exists and is explicitly deactivated; absence is not deactivation (see
    `IdentityProvider.resolve`).
    """

    user_id: str | None
    is_active: bool


@runtime_checkable
class IdentityProvider(Protocol):
    """How the Core reaches a deployment's identity records."""

    def session(self) -> AsyncGenerator[AsyncSession, None]:
        """The database session identity resolution runs on.

        Part of the seam because it is not always `get_db`. A provider backed by
        row-level security needs a master/RLS-bypass session: identity has to be
        resolved *before* the RLS session variable identifying the caller can be
        set, so the resolving query cannot itself be subject to RLS.
        """
        ...

    async def resolve(self, db: AsyncSession, claims: dict) -> ResolvedIdentity:
        """Resolve the verified token's claims to a deployment identity.

        One call rather than separate id and is-active lookups, because every
        implementation answers both from the same row and splitting them costs a
        second round-trip on every authenticated request.

        A caller with no record MUST resolve to `is_active=True` with a None
        `user_id`. Treating absence as deactivation would lock out every user of
        a deployment that provisions lazily.

        Providers that create the record on first login do so here.
        """
        ...

    async def sync_platform_admin(
        self, db: AsyncSession, user_id: str | None, is_member: bool
    ) -> None:
        """Reconcile the caller's platform-admin state with their Cognito group.

        The Cognito group is the source of truth. Deployments that mirror it into
        a table — because RLS policies read the table, not the token — reconcile
        here. Deployments that read the group directly implement this as a no-op.
        """
        ...

    async def resolve_permissions(
        self, db: AsyncSession, user_id: str | None
    ) -> frozenset[str]:
        """The caller's effective permission codes.

        For deployments that grant permissions through database-held roles. The
        ADR-0004 default authorization model works from Cognito groups on the
        token and needs no lookup, so the default provider returns an empty set.
        """
        ...
