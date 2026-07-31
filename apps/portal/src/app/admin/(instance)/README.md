# Instance admin surfaces (`app/admin/(instance)/`)

This directory is your instance's home for its **own admin routes** inside the
otherwise template-owned portal. It is **user-owned** (`core-manifest.json`), so
you edit it freely: the core-ownership guard won't block your commits and
`biffo core upgrade` won't treat it as template drift.

It is the portal's counterpart to
[ADR-0022](../../../../../../docs/ADR/0022-product-domain-modules-are-user-owned-guests.md)'s
`services/api/src/api/domains/<name>/` carve-out, and is specified in
[ADR-0028](../../../../../../docs/ADR/0028-instance-owned-portal-admin-surfaces.md).

## Why the parentheses

`(instance)` is a Next.js **route group**: it contributes no URL segment. A page
at `(instance)/demo-requests/page.tsx` serves `/admin/demo-requests/`, exactly as
if the group were not there — same URL, same `app/admin/layout.tsx` (nav, auth
guard), same static export. Only *ownership* changes. Verified against this
app's real `output: 'export'` + `trailingSlash: true` build, which emits
`out/admin/demo-requests/index.html`.

The template will never ship a route into this directory, which is what makes it
safe to user-own: unlike carving out `components/` or `lib/`, there is no way for
an upgrade to propose deleting what you put here.

## Adding a surface

1. Create the route: `(instance)/<surface>/page.tsx` (plus its test). Co-locate
   whatever it needs — API clients, components, hooks — inside the group, so the
   same one prefix covers all of it.
2. Make it discoverable by adding an entry to
   [`src/instance-nav.ts`](../../../instance-nav.ts), which is user-owned too:

   ```ts
   export const INSTANCE_NAV_LINKS: InstanceNavLink[] = [
     { href: '/admin/demo-requests/', label: 'Demo requests' },
   ]
   ```

   Do **not** edit `src/components/nav.tsx` — it is template-owned, and it
   already renders your entries after its own links.

Use trailing-slash hrefs (`/admin/x/`, not `/admin/x`): this app is a static
export, so the unslashed form resolves onto the route's raw RSC payload (#275).
The seam normalises them for you, but write them correctly anyway.
