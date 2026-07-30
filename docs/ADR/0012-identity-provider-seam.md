# ADR-0012: Identity is resolved through a core seam, not an API-owned table

**Status:** Accepted
**Date:** 2026-07-19
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

Biffo Core ships a `User` SQLAlchemy model (`services/api/src/api/models/user.py`)
backed by a `public.users` table, and `middleware/auth.py` reads it directly to
enforce the deactivation check. The Core API therefore _owns_ the identity record.

That assumption does not survive contact with a real deployment. In the **tabsii**
instance, users are not a Core concern: identity lives in `tabsii.users`, part of
the business schema vendored through the ADR-0005 DDL import, alongside
`tabsii.platform_admins`, `tabsii.roles`, `tabsii.permissions` and
`tabsii.user_role_assignments`. The instance retired `public.users` outright
(tabsii-platform#95), because two competing user tables in one database is not a
seam — it is a bug waiting to happen. Which one is the system of record? Which one
does a foreign key point at? Which one does an admin screen edit?

Retiring it meant **forking `middleware/auth.py`**. The instance's copy is 359
lines against the template's 163: it resolves the caller's canonical user id
(lazily creating the row on first login), mirrors the `platform_admin` Cognito
group into the table RLS reads, resolves effective permission codes, and runs the
whole thing on a master/RLS-bypass session (`get_admin_db`) that the template does
not have at all.

The presenting symptom is a merge conflict. `services/api/` is template-owned, so
**every `biffo core upgrade` conflicts on `auth.py`**, and the conflict is not
mechanical: taking the template's side silently reintroduces a dependency on a
table the instance deliberately dropped, re-breaking #95 and, because this is the
authentication path, doing so in the least forgiving place in the system. That is
a security regression one careless merge away, on every upgrade, forever.

**ADR-0011** already settled the direction — richer authorization is a core
capability "owned by the deployment," and it explicitly cites tabsii's RLS
implementation as the worked example. What it did not do is give deployments a
_place_ to put that ownership. With no seam, "owned by the deployment" degrades in
practice to "forked from the template," which is precisely what happened.

The constraint that shapes the answer: a fresh `biffo init` has no business schema
at all. Whatever we do, a brand-new instance must still authenticate out of the
box.

## Decision

**The Core API resolves identity through an `IdentityProvider` seam. It does not
assume it owns the identity table.**

1. **`middleware/auth.py` never names a table.** It verifies the Cognito JWT —
   which stays core, unforkable, and provider-independent — then delegates every
   database-backed identity question to the configured provider.

2. **The seam is four operations**, derived from what the tabsii implementation
   actually needs rather than invented up front:

   ```python
   class IdentityProvider(Protocol):
       def session(self) -> AsyncGenerator[AsyncSession, None]: ...
       async def resolve(self, db, claims: dict) -> ResolvedIdentity: ...
       async def sync_platform_admin(self, db, user_id: str | None, is_member: bool) -> None: ...
       async def resolve_permissions(self, db, user_id: str | None) -> frozenset[str]: ...
   ```

   `ResolvedIdentity` carries `user_id` and `is_active`. A caller with no record
   resolves to `is_active=True` with a None `user_id` — absence is not
   deactivation, or a lazily-provisioning deployment would lock out every user.

3. **The template ships `DefaultIdentityProvider`**, backed by the existing
   `public.users` model. A fresh scaffold keeps working exactly as it does today:
   `resolve` reads the row by `cognito_sub`, `sync_platform_admin` is a no-op
   (there is no platform-admin table to mirror), and `resolve_permissions`
   returns an empty set — the default authz model is Cognito groups plus ADR-0004
   permission codes, which need no lookup.

4. **A deployment overrides the provider, not the auth path.** tabsii ships a
   `TabsiiIdentityProvider` against `tabsii.*` and deletes its `auth.py` fork.
   Retiring `public.users` becomes a supported configuration rather than a patch.

5. **The provider owns its session.** RLS-based providers must run on a
   master/RLS-bypass session, because identity has to be resolved _before_
   `app.current_user_id` can be set. `require_auth` therefore depends on a fixed
   `identity_session` that dispatches to the provider at request time, rather
   than binding `get_db` into its signature at import time.

6. **This is an in-core extension point, not a plugin.** It is emphatically not
   the ADR-0003 installable plugin system, and ADR-0011 stands unamended:
   authorization remains a core concern that is always present. The seam governs
   _where the identity record lives_ — never _whether_ authorization runs.

`AuthenticatedUser` gains `user_id`, `is_platform_admin` and `permissions`,
populated from the provider. Fields default to fail-closed values so existing
non-auth construction sites (tests, dependency overrides) keep working.

> **Amended during implementation (2026-07-19).** Two details in points 2, 3 and
> 5 changed once the code was written. Both are corrections to this ADR, made in
> the open rather than quietly diverged from:
>
> - **`ensure_active` + `resolve_user_id` merged into `resolve`.** As originally
>   specified they were two lookups keyed on the same `cognito_sub`, returning
>   columns of the same row — a second database round-trip on every authenticated
>   request, where the pre-seam code did one. Every implementation answers both
>   questions from one row, so the interface should ask once.
> - **The Core does not gain `get_admin_db`.** The base template has no
>   app-role/RLS split, so a `get_admin_db` here would be an alias for `get_db`
>   that only _looked_ like a security boundary. The requirement was always that
>   the provider selects its session; owning `session()` delivers that without
>   the misleading duplicate, and a deployment supplies whatever session its model
>   needs. This also retires the "two session helpers is a sharper tool" trade-off
>   recorded below for the base template — it now applies only to deployments that
>   introduce the split themselves.

> **Confirmed 2026-07-19.** Issue #229 asked whether the template should adopt
> tabsii's RLS-based RBAC as its default, which would have introduced exactly the
> app-role/RLS split the amendment above says is absent. **It was decided not
> to**: RLS stays a deployment's own concern, implemented through this seam.
>
> So the amendment stands as written rather than by accident — there is still no
> privilege split in the base template, and a `get_admin_db` here would still be
> an alias for `get_db` wearing the costume of a security boundary.
>
> The reasoning that settled it is worth keeping next to this decision, because
> it is the same shape: the template's suite runs on SQLite, which has no RLS, so
> backporting would have shipped a security mechanism the template cannot test.
> ADR-0011's `rbac` plugin is the cautionary precedent — present, plausible,
> verified by nothing, read by nothing.
>
> **This reverses if a deployment ever uses the multi-tenant seam for real.**
> ADR-0001 keeps `tenant_id` at `"default"` today, so API-layer scoping is all
> that separates tenants and a single scoping bug leaks across them. With two
> real tenants in one deployment, RLS stops being defence in depth and becomes
> what makes such a bug survivable. At that point this amendment — and the
> `get_admin_db` question with it — should be revisited, not before.

> **Amended 2026-07-30 — a provider's home is `domains/<name>/`, not `identity/`.**
> This ADR specified how a deployment implements and installs a provider but never
> said **where the provider may live**, and the only pointer was
> `identity/__init__.py`'s "in the API's startup path". Both gaps resolved to
> template-owned files, so the seam that exists to stop a deployment forking Core
> made it fork Core anyway:
>
> - tabsii-platform's provider sits at `identity/tabsii.py` — an instance-only file
>   inside a template-owned tree. `biffo core upgrade` correctly never touches it,
>   but the commit-time guard asks only whether a path is under a template-owned
>   prefix, so editing it needs a per-commit `Core-Divergence` trailer.
> - Installing it means three lines wedged into template-owned `main.py`.
>
> **A deployment's provider module belongs in `domains/<name>/`, and the
> `set_identity_provider(...)` call belongs in that package's `__init__.py`.**
> `domains/` is user-owned (`core-manifest.json`), so neither the guard nor an
> upgrade has any claim on it. Nothing in the mechanism changed — this records
> what was already possible and blesses it:
>
> - `build_domain_router()` imports every package under `domains/`, treating
>   `routers` as optional, so a domain may register with a core registry and export
>   no routes at all.
> - It runs at module scope in `main.py` above `handler = Mangum(app,
>   lifespan="off")`. With no lifespan there is no startup event, so **import time
>   is the only registration window** — and it is a sufficient one.
> - `identity_session` already dispatches through `get_identity_provider()` per
>   request (point 5), so middleware imported before the domains still resolves
>   against the installed provider.
>
> This is the same shape ADR-0022 applied to product-domain code, and the same
> import-time registration `api.events.registry` documents for event types. It is
> also what tabsii's own `domains/tabsii/__init__.py` already does for two other
> core registries, and what its divergence register asked for.
>
> The ordering is now pinned by `test_identity_provider_registration.py`. It was
> load-bearing and untested, which is precisely how #668 — the same
> `build_domain_router()` call, moved one line — silently dropped 21 routes past a
> green suite and a green CI.
>
> ADR-0002's constraint at *Compliance* is unaffected: `domains/` is inside
> `services/api/`, so providers still live in the one service holding a database
> client.

## Options Considered

### Option A — `IdentityProvider` seam (chosen)

**Pros:**

- Fresh scaffolds keep a working default; nothing regresses out of the box.
- Ends the recurring `auth.py` conflict permanently, removing a standing security
  hazard from the upgrade path.
- Mirrors the pluggability the repo already uses for cloud and source-control
  adapters — one interface, provider-specific implementations.
- Retiring `public.users` becomes a first-class supported choice.

**Cons:**

- A new abstraction on the authentication path, which is the last place anyone
  wants indirection.
- The interface is inferred from exactly one real implementation, so it will
  probably need revision when a second appears.

### Option B — Configurable schema and table names

Keep the SQL in `auth.py`, drive `identity_schema` / `identity_users_table` from
settings.

**Pros:**

- Small, obvious change; no new abstraction.

**Cons:**

- Requires interpolating identifiers into raw SQL, which is injection-prone unless
  quoted with care, on the authentication path.
- Only parameterises _names_. tabsii's divergence is behavioural — lazy row
  creation, event emission, platform-admin mirroring, RLS-bypass sessions,
  permission resolution — and none of that is a table name.
- The conflict does not go away; it just moves.

### Option C — Port tabsii's RLS/RBAC wholesale as the template default

**Pros:**

- Most faithful to "this is how it should be done"; every instance gets
  database-enforced RBAC as standard.

**Cons:**

- Imposes a heavyweight authz model, and the operational burden of RLS, on every
  future scaffold regardless of need.
- The implementation is inseparable from a business schema the template does not
  and should not have.
- Much larger change with a far worse blast radius if wrong.

### Option D — Status quo: each instance forks `auth.py`

**Pros:**

- No work.

**Cons:**

- Guarantees a conflict on the authentication path at every core upgrade, where
  the safe-looking resolution is the insecure one. This is the problem, not a
  solution.

## Rationale

The deciding factor is the fresh-scaffold constraint. Option C fails it outright —
a new instance has no business schema, so RLS-backed identity has nothing to bind
to. Option B fails it more quietly: it parameterises names while the actual
divergence is behavioural, so tabsii would still need its fork and the conflict
would survive.

Between the remaining candidates, Option A is the only one that lets both truths
hold at once: a new instance needs identity to just work, and a mature instance
needs identity to live in its own system of record. A seam is exactly the
construct for "same question, deployment-specific answer."

Accepting the cost honestly: this adds indirection to the authentication path, and
it is designed against a single implementation. Both are real. They are worth it
because the alternative is a recurring merge conflict whose most natural
resolution silently re-enables a table the deployment removed — and `auth.py` is
the file where that class of mistake is least survivable.

Note also what this decision does _not_ do: it does not remove `public.users` from
the template. The model survives as the default provider's backing store. What
changes is that the Core no longer _assumes_ it — identity ownership becomes a
deployment's decision instead of the template's.

## Consequences

### Positive

- `auth.py` stops conflicting on core upgrade; tabsii deletes a 359-line fork and
  can then take core upgrades cleanly.
- The dangerous resolution — reinstating a dropped identity table — becomes
  unreachable rather than merely discouraged.
- ADR-0011's "owned by the deployment" acquires a mechanism instead of an
  expectation.
- Deactivation enforcement, lazy provisioning and permission resolution get one
  documented contract rather than per-instance variants.

### Negative / Trade-offs

- Indirection on the authentication path.
- An interface generalised from one implementation; expect churn at the second.
- Two session helpers (`get_db`, `get_admin_db`) is a sharper tool than one, and
  choosing wrongly means running identity queries with RLS bypassed.

### Neutral

- `public.users` and the `User` model remain in the template as the default
  provider's store.
- The JWT verification path is unchanged.
- Instances that never override see no behavioural difference.

## Compliance

- `middleware/auth.py` must contain no table names and no `models.user` import;
  identity access goes through the provider. Reviewable in the diff, and a lint
  rule is worth adding if it recurs.
- The default provider is covered by the existing auth test suite, so a fresh
  scaffold's behaviour is pinned.
- ADR-0002 still holds: providers live inside `services/api/` and no other service
  gains a database client.
- tabsii's port is not complete until its `auth.py` fork is deleted and a core
  upgrade applies cleanly with no conflict in that file.

## Scope: `require_auth` only

**The identity-provider seam covers the `require_auth` path only.** `require_forwarded_user`
(the plugin/sibling-forwarded-token ingress, used by plugin chat routes per ADR-0017 §3
and internal owner-scoped plugin data routes) intentionally stays a lightweight, DB-free
claims check. It calls `identity_from_token()`, which performs pure claims mapping
without calling `provider.resolve()`, and therefore does not populate `AuthenticatedUser.user_id`.
Routes that use `require_forwarded_user` and need an owner identity fall back to the raw
Cognito `sub` claim — this is correct and load-bearing (see `routing/owner_data_handlers.py`).

Routing the forwarded-token path through the provider would add a database round-trip on
every plugin-forwarded call; since plugins must never gain database access (ADR-0002),
this scope boundary is deliberate, not an oversight. A deployment with a custom identity
provider should be aware that **plugin-owned data is currently attributed by raw Cognito
`sub`, not the provider's resolved canonical identity**. This is a documented, scoped
limitation of the current architecture, and a candidate for future refining if the plugin
surface grows to require tighter integration with canonical identity resolution.

## Related Decisions

- **ADR-0011** — Authorization is a core concern, not a plugin. Unamended; this
  ADR supplies the seam its "owned by the deployment" clause implies.
- **ADR-0005** — DDL Import Module. Supplies the business schema an overriding
  provider reads from.
- **ADR-0004** — Generic CRUD layer and table permissions. Remains the default
  authorization model; `resolve_permissions` is how a deployment extends it.
- **ADR-0006** — Core Upgrade and Template Sync. The upgrade conflict this
  decision exists to eliminate.
- **ADR-0002** — API-only data integration. Providers are API-internal.
