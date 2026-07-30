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

from collections.abc import AsyncGenerator, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, runtime_checkable

from sqlalchemy.ext.asyncio import AsyncSession

# The profile columns a caller may write through `upsert_profile`. An explicit
# allow-list because the pre-seam admin router derived its writable set by
# subtraction — "every request field that is not one of the three Cognito ones" —
# and `setattr`'d the remainder onto the ORM object unchecked. Behind a seam that
# would hand a provider an untyped write path into its own store.
#
# `last_login_at` is here because `/auth/me` sets it on every login. Identity
# columns (`cognito_sub`, `email`, `username`, `tenant_id`) are deliberately NOT:
# they seed a row at creation and Cognito owns them thereafter.
WRITABLE_PROFILE_FIELDS = frozenset(
    {
        "last_login_at",
        "organization_id",
        "job_role",
        "address_line1",
        "address_line2",
        "city",
        "region",
        "postal_code",
        "country",
    }
)


@dataclass(frozen=True)
class UserProfile:
    """A deployment's user record, flattened for the Core's profile surfaces.

    Deliberately a plain dataclass rather than the `User` ORM object the
    pre-seam routers returned, for three reasons:

    - **`organization_name` is resolved, not related.** The Core's admin surface
      wants the organization's name, which it used to reach through
      `selectinload(User.organization)`. A provider over its own schema has no
      foreign key into the Core's `organizations`, so carrying a relationship
      across the seam would re-couple exactly what ADR-0012 separates. The
      provider resolves the name however it can and passes a string.
    - **It is fully materialised.** `/auth/me` returned a live, uncommitted ORM
      instance that FastAPI serialised *before* `get_db` committed, which is why
      the `flush()`/`refresh()` there were load-bearing. Every field here is a
      value, so serialisation cannot depend on session state.
    - **It cannot lazy-load.** An ORM object crossing a seam can trigger IO from
      inside response serialisation, on a session the provider may already have
      closed.
    """

    id: str
    tenant_id: str
    created_at: datetime
    updated_at: datetime
    email: str
    username: str
    is_active: bool
    last_login_at: datetime | None = None
    organization_id: str | None = None
    organization_name: str | None = None
    job_role: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    region: str | None = None
    postal_code: str | None = None
    country: str | None = None


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

    def session(self) -> AsyncGenerator[AsyncSession]:
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

    async def resolve_permissions(self, db: AsyncSession, user_id: str | None) -> frozenset[str]:
        """The caller's effective permission codes.

        For deployments that grant permissions through database-held roles. The
        ADR-0004 default authorization model works from Cognito groups on the
        token and needs no lookup, so the default provider returns an empty set.
        """
        ...

    # --- Profile surface ----------------------------------------------------
    # The four operations above answer "may this caller in?". These answer "what
    # does the Core display about a user?", and they exist because the profile
    # routers used to answer it themselves by querying `public.users` directly —
    # reintroducing, one layer above the seam, the assumption the seam removes. A
    # deployment that legitimately retired `public.users` could not take the
    # profile feature at all.
    #
    # Keys are the Cognito `sub` throughout, except `get_profile_by_id`. That
    # asymmetry is deliberate, not an oversight: `sub` is the only identifier
    # every deployment shares, while `ResolvedIdentity.user_id` is documented as
    # the *deployment's* canonical id and need not be a Core UUID.

    async def list_profiles(self, db: AsyncSession, tenant_id: str) -> list[UserProfile]:
        """Active users in the tenant, oldest first.

        Unpaginated, matching the endpoint it serves. The admin listing is
        paginated by Cognito rather than by the store, so it does not come
        through here — one method carrying an opaque page token that meant
        different things per caller would be a worse contract than two methods.
        """
        ...

    async def get_profile_by_id(
        self, db: AsyncSession, tenant_id: str, user_id: str
    ) -> UserProfile | None:
        """One user by the deployment's canonical id, or None.

        The only lookup in the Core keyed on the id rather than the subject,
        because `GET /users/{user_id}` is addressed that way.
        """
        ...

    async def get_profile(self, db: AsyncSession, subject: str) -> UserProfile | None:
        """One user by Cognito subject, or None if this store holds no record.

        None is ordinary, not an error: the admin surface lists users straight
        from Cognito, so it routinely sees people who have never logged in and
        therefore have no row. Callers render such a user with empty profile
        fields.
        """
        ...

    async def get_profiles(
        self, db: AsyncSession, subjects: Sequence[str]
    ) -> dict[str, UserProfile]:
        """Profiles for many subjects, keyed by subject; missing ones are absent.

        Batched because the admin listing needs one profile per Cognito user on
        the page, and per-row lookups would make the page cost O(n) round-trips.
        """
        ...

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
        """Ensure a record exists for `subject`, apply `fields`, return it.

        The boolean is True when this call created the record. It is returned
        rather than acted on because the caller must be the one to emit
        `USER_CREATED`: `emit_event` buffers onto the request session's `info`
        and `get_db` publishes after that session commits, whereas `session()`
        exists precisely so a provider may run on a different, RLS-bypassing
        session. A provider emitting the event itself would buffer it onto a
        session nothing ever publishes, and it would vanish silently.

        `email`, `username` and `tenant_id` seed a newly created record and are
        ignored when one already exists — Cognito owns them, and a login must not
        quietly rewrite identity columns.

        `fields` must contain only `WRITABLE_PROFILE_FIELDS`. A key present with
        value None clears that column; a key absent leaves it untouched, which is
        the PATCH semantics the admin surface needs.
        """
        ...

    async def set_active(self, db: AsyncSession, subject: str, active: bool) -> None:
        """Mirror a suspend/reactivate onto the record, if there is one.

        Cognito is the source of truth for whether a user may sign in; this only
        keeps a local mirror consistent. **Affecting no record is success, not an
        error** — a user provisioned but never logged in has none, and suspending
        them must still work.
        """
        ...
