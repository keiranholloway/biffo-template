# ADR-0028: Instance admin surfaces are user-owned guests in the core portal

**Status:** Accepted
**Date:** 2026-07-31
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

ADR-0022 gave an instance's product-domain code a user-owned home *inside* the
template-owned core API (`services/api/src/api/domains/<name>/`). The portal
never got the equivalent, and `apps/portal/` is a **template-owned** prefix that
beats the user-owned `apps/` on longest-match. So an instance with its own admin
surface had **nowhere legitimate to put it**: the only way to ship one was
permanent, declared divergence in files the template keeps changing.

**Driving case:** `tabsii-platform` (#207). Four files, whose own divergence
declaration contains the diagnosis — *"Product code with nowhere legitimate to
go … there is no portal equivalent of ADR-0022's `domains/` carve-out"*:

| File | What it is |
| --- | --- |
| `apps/portal/src/app/admin/demo-requests/page.tsx` | the surface itself |
| `apps/portal/src/app/admin/demo-requests/page.test.tsx` | its test |
| `apps/portal/src/lib/demo-request-admin-api.ts` | its API client |
| `apps/portal/src/components/nav.tsx` | **declared divergence**, purely to add one link |

That last row is the hard half. **An instance cannot add a route without also
making it discoverable**, so a carve-out that covers only the route leaves the
instance patching a template-owned file for every surface it adds — a three-way
merge on `nav.tsx` at every upgrade that touches the nav, for ever.

Moving the surface elsewhere was ruled out on content, not convenience: a
sibling (ADR-0007) is a different plane and a plugin (ADR-0003) is not an
instance's own operator console — which is exactly what `apps/portal/` *is*.

## Decision

Two user-owned entries in `core-manifest.json`, resolved ahead of the
template-owned `apps/portal/` by the same longest-prefix-wins rule that already
gives `services/api/src/api/domains/` precedence over `services/api/`.

1. **`apps/portal/src/app/admin/(instance)/` is user-owned** — the home for an
   instance's own admin routes and anything they need co-located (components,
   API clients, hooks, tests).

   `(instance)` is a Next.js **route group**: it contributes no URL segment.
   `(instance)/demo-requests/page.tsx` serves `/admin/demo-requests/`, under the
   same template-owned `app/admin/layout.tsx` (nav + auth guard), with no change
   to the URL, the layout, or the static export. **Verified**, not assumed —
   built against this app's real `output: 'export'` + `trailingSlash: true`
   config, which emitted `out/admin/demo-requests/index.html`. Only *ownership*
   changes.

2. **`apps/portal/src/instance-nav.ts` is user-owned** (an exact-file entry) —
   the discovery half. It exports `INSTANCE_NAV_LINKS`, shipped **empty** by the
   template. The template-owned `nav.tsx` renders
   `resolveInstanceNavLinks(INSTANCE_NAV_LINKS)` after its own links.

   The seam is split on purpose: the **shape** lives in the template-owned
   `apps/portal/src/lib/instance-nav-contract.ts`, so the template can evolve
   it; the **data** lives in the user-owned file, so an instance only ever
   appends. `resolveInstanceNavLinks` fails soft (a malformed entry is dropped,
   not thrown — the nav renders inside the shared admin layout, so throwing
   would take down every admin page) and canonicalises hrefs to the
   trailing-slash form this static export requires. That last part matters:
   `internal-links.test.ts` guards literal `href="…"` attributes against #275,
   but instance nav entries are *data* and that scanner cannot see them.

Both paths are **seeded once** and then belong to the instance, exactly as
ADR-0022 seeds `domains/`. The route group ships a `README.md` pointing at this
pattern.

This does **not** address renaming a *core* nav label ("Plugins" → "Plugin
store"), which is a branding question, deliberately out of scope.

## Options Considered

### Option A — `(instance)/` route group + a nav registry (chosen)

**Pros:**
- Covers discovery, not just the route, so an instance stops patching
  template-owned files for its own product work at all.
- Needs **no resolver change** — prefix and exact-file matching with
  longest-match-wins already exist in `cli/src/lib/core-manifest.ts`.
- A route group is invisible in the URL space, so relocating an existing surface
  into it is mechanical and changes no behaviour.

**Cons:**
- `nav.tsx` now imports a user-owned module (see Consequences).

### Option B — Carve out `components/`, `lib/`, `context/`

Rejected: this is the #279-part-1 trap. Those are directories the template
itself ships into, so `core upgrade` would propose deleting an instance's files
or conflict on them. `(instance)/` is the opposite — a name the template will
never ship into, existing solely to be the instance's, and invisible in the URL
space. That is the same reasoning that made `domains/` safe.

### Option C — Leave it declared divergence

Rejected: it is what happens today, and it costs a three-way merge on `nav.tsx`
for ever. The declaration itself says the file has "nowhere legitimate to go".

### Option D — Wait for #558 (consolidate plugin frontend hosting)

Rejected: #558 is about *plugin* frontends. This is an instance's own admin
route, and #558 has not moved since 2026-07-25.

## Consequences

- Every instance has a standard, user-owned home for its own admin surfaces, and
  adding one never touches a template-owned file.
- **`nav.tsx` (template-owned) imports `@/instance-nav` (user-owned).** For a
  freshly scaffolded instance this is a non-issue — `biffo init` copies the
  seeded file. But `biffo core upgrade` does not carry user-owned paths, so an
  instance created *before* this core version receives the new `nav.tsx` without
  the file it imports and its portal build fails with a module-not-found. The
  fix is one file, and the upgrade PR's own CI surfaces it before merge:

  ```ts
  // apps/portal/src/instance-nav.ts
  import type { InstanceNavLink } from '@/lib/instance-nav-contract'

  export const INSTANCE_NAV_LINKS: InstanceNavLink[] = []
  ```

  This is inherent to any bundled front-end seam: unlike ADR-0022's Python
  discovery, which globs `domains/` at runtime and mounts nothing when it is
  absent, a bundler resolves the import at build time and cannot degrade. A
  general "seed a user-owned file the instance lacks" carry in `core upgrade`
  would remove the manual step; it is deliberately not in scope here.
- `tabsii-platform` can relocate its four files into the group, replace its
  `nav.tsx` patch with one `INSTANCE_NAV_LINKS` entry, and drop that divergence
  declaration.
- The carve-out is guarded executably: `cli/src/lib/portal-instance-ownership.test.ts`
  asserts ownership against the real manifest and resolver (with template-owned
  controls), and `apps/portal/src/components/nav.test.tsx` asserts the registry
  actually renders, so the seam cannot silently rot.

## Related Decisions

- **ADR-0022** — the API-side carve-out this mirrors, and the source of the
  "user-owned guest inside a template-owned tree" pattern.
- **ADR-0006** — the ownership/upgrade model both extend (longest-prefix-wins).
- **ADR-0021 / #558** — plugin frontend hosting; adjacent, but about plugins
  rather than an instance's own admin routes.
