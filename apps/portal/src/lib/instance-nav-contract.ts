/**
 * The contract between the template-owned admin nav and an **instance's own**
 * nav entries (ADR-0028).
 *
 * `apps/portal/` is template-owned, so before this seam existed an instance
 * that added an admin route had to patch the template-owned
 * `components/nav.tsx` to make the route discoverable — a permanent declared
 * divergence and a three-way merge on every upgrade that touched the nav.
 *
 * The split is deliberate: the **shape** lives here (template-owned, so the
 * template can evolve it) and the **data** lives in `@/instance-nav`
 * (user-owned, so an instance appends to it freely). `nav.tsx` renders
 * `resolveInstanceNavLinks(INSTANCE_NAV_LINKS)` after its own links.
 */

export interface InstanceNavLink {
  /**
   * An internal portal path, e.g. `/admin/demo-requests/`. Must start with
   * `/`; a missing trailing slash is added for you (see below). External URLs
   * are not supported and are dropped.
   */
  href: string
  /** The link text shown in the nav. */
  label: string
}

/**
 * Canonicalise an internal href for this app's `trailingSlash: true` static
 * export.
 *
 * Issue #275: a client-side navigation to the *unslashed* form of a statically
 * exported route lands on the route's RSC payload (`<route>/index.txt`) and
 * renders raw serialised React, because static hosting issues no redirect to
 * the canonical form. `internal-links.test.ts` guards that for literal
 * `href="..."` attributes, but an instance's nav entries are *data* — that
 * scanner cannot see them. So the seam normalises them instead of trusting
 * every instance to remember.
 */
export function normalizeInstanceHref(href: string): string {
  const boundary = href.search(/[?#]/)
  const path = boundary === -1 ? href : href.slice(0, boundary)
  const suffix = boundary === -1 ? '' : href.slice(boundary)
  if (path === '' || path.endsWith('/')) return path + suffix
  return `${path}/${suffix}`
}

/**
 * Filter and canonicalise the instance-declared nav entries.
 *
 * Fail-soft by design: a malformed entry is dropped rather than thrown, so a
 * typo in a user-owned file degrades one link instead of blanking the whole
 * admin nav (it is rendered inside the shared admin layout — throwing here
 * takes down every admin page at once).
 *
 * Dropped: blank labels, hrefs that are not internal absolute paths, and
 * duplicates of an href already present (first declaration wins).
 */
export function resolveInstanceNavLinks(
  links: readonly InstanceNavLink[] | undefined,
): InstanceNavLink[] {
  if (links == null) return []
  const seen = new Set<string>()
  const resolved: InstanceNavLink[] = []
  for (const link of links) {
    // Deliberately re-typed as partial: the declarations come from a
    // user-owned file, so the compiler's word that these are non-nullish
    // strings is a promise about the template's own types, not about what an
    // instance actually wrote.
    const entry = link as Partial<InstanceNavLink> | null | undefined
    const label = entry?.label?.trim()
    const href = entry?.href?.trim()
    if (label == null || label === '') continue
    if (href == null || !href.startsWith('/')) continue
    const normalized = normalizeInstanceHref(href)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    resolved.push({ href: normalized, label })
  }
  return resolved
}
