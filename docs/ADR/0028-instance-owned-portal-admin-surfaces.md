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

2. **`apps/portal/src/instance-nav.ts` is user-owned and OPTIONAL** (an
   exact-file entry) — the discovery half. It exports `INSTANCE_NAV_LINKS`, and
   the template does **not** ship it: `@/instance-nav` resolves to the
   template-owned `src/lib/instance-nav-empty.ts` unless an instance creates its
   own, which then takes precedence. The template-owned `nav.tsx` renders
   `resolveInstanceNavLinks(INSTANCE_NAV_LINKS)` after its own links either way.
   See Consequences for why the default must live on the template side, and for
   the three resolvers that have to agree about it.

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
- **`nav.tsx` (template-owned) imports `@/instance-nav`, which is optional.**
  This was originally shipped as a *mandatory* user-owned file, and that was
  wrong: `biffo core upgrade` never carries user-owned paths, so every instance
  created before this ADR would have taken the new `nav.tsx` without the module
  it imports and failed `module not found` in the upgrade PR's own CI. Both live
  instances were in exactly that state. **Amended before any instance upgraded.**

  The file is now optional. `apps/portal/src/lib/instance-nav-empty.ts` is
  template-owned, always present, and is what `@/instance-nav` resolves to by
  default; an instance that wants entries creates `src/instance-nav.ts` and it
  takes precedence. The "declare nothing" case requires the instance to do
  nothing at all.

  **Three resolvers have to agree, and each needed its own handling:**

  | Resolver | Where | How |
  | --- | --- | --- |
  | `tsc` | `apps/portal/tsconfig.json` | `paths` maps `@/instance-nav` to the empty default |
  | Next build | `apps/portal/next.config.ts` | webpack alias overrides when the instance file exists |
  | vitest | `apps/portal/vitest.config.ts` | its own `resolve.alias`; it reads neither of the above |

  Two things here are counter-intuitive and were found by building, not by
  reasoning:

  - **A tsconfig fallback list does not work.** Next's SWC loader rejects a
    multi-element `paths` array for a non-wildcard key — *"should be an array
    with one element because the src path does not contain a wildcard"* — and it
    surfaces as a Rust panic loading `next.config`, naming neither this seam nor
    the file. `paths` must stay single-element; the override goes in webpack.
  - **Aliasing the `@/instance-nav` specifier does nothing.** SWC rewrites
    tsconfig `paths` at transform time, so webpack never sees that key. The
    alias must target the *resolved* default path. The specifier version built
    successfully and silently emitted a bundle containing the empty default —
    a green build proving nothing, which is why this was verified by grepping
    the emitted bundle for a probe value rather than by the build's exit code.

  The general lesson stands and is worth stating separately: **a seam whose
  "declare nothing" case still requires the instance to do something will break
  every instance that predates it.** ADR-0022's Python discovery avoids this by
  globbing at runtime; anything bundled resolves earlier and harder, so the
  default must live on the template side.
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
