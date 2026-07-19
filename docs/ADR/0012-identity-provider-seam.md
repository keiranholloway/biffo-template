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
       async def ensure_active(self, db, cognito_sub: str) -> None: ...
       async def resolve_user_id(self, db, claims: dict) -> str: ...
       async def sync_platform_admin(self, db, user_id: str, is_member: bool) -> None: ...
       async def resolve_permissions(self, db, user_id: str) -> frozenset[str]: ...
   ```

3. **The template ships `DefaultIdentityProvider`**, backed by the existing
   `public.users` model. A fresh scaffold keeps working exactly as it does today:
   `ensure_active` enforces `User.is_active`, `resolve_user_id` resolves/creates
   the row, `sync_platform_admin` is a no-op (there is no platform-admin table to
   mirror), and `resolve_permissions` returns an empty set — the default authz
   model is Cognito groups plus ADR-0004 permission codes, which need no lookup.

4. **A deployment overrides the provider, not the auth path.** tabsii ships a
   `TabsiiIdentityProvider` against `tabsii.*` and deletes its `auth.py` fork.
   Retiring `public.users` becomes a supported configuration rather than a patch.

5. **The provider declares its session dependency.** RLS-based providers must run
   on a master/RLS-bypass session, because identity has to be resolved _before_
   `app.current_user_id` can be set. The Core therefore gains `get_admin_db`
   alongside `get_db`, and the provider selects which it needs.

6. **This is an in-core extension point, not a plugin.** It is emphatically not
   the ADR-0003 installable plugin system, and ADR-0011 stands unamended:
   authorization remains a core concern that is always present. The seam governs
   _where the identity record lives_ — never _whether_ authorization runs.

`AuthenticatedUser` gains `user_id`, `is_platform_admin` and `permissions`,
populated from the provider. Fields default to fail-closed values so existing
non-auth construction sites (tests, dependency overrides) keep working.

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
