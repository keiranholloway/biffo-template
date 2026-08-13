/**
 * The contract between the portal's admin nav and plugin-declared nav
 * entries (issue #1555 — the plugin sibling of ADR-0028's instance seam,
 * see `instance-nav-contract.ts`).
 *
 * A plugin can declare a `nav-link` in its manifest's `ui_components`
 * (`_skeletons/registry/registry-schema.json`). Unlike an instance's own
 * nav entries, which are build-time data (`@/instance-nav`), which plugins
 * are installed and what they're gated behind are properties of the
 * *running deployment* — and the portal is a fully static export
 * (`output: 'export'` in next.config.ts), so there is no build-time route
 * generation to hang this off. This can only be resolved **client-side, at
 * runtime**, from the installed-plugins response the portal already fetches
 * (`fetchInstalledPlugins`, `GET /api/v1/admin/plugins/available`) and the
 * caller's own Cognito groups (`cognito-groups.ts`).
 *
 * Fail-soft by the same rationale as the instance contract: a malformed or
 * unauthorized entry is dropped, not thrown. This renders inside the
 * portal's shared admin layout, so a throw here would blank the whole admin
 * nav for every plugin (and every core link after it), not just the one bad
 * entry.
 */

/** The fields this module reads off an installed-plugin API response. */
export interface PluginNavSource {
  name: string
  has_admin_ingress: boolean
  admin_required_group: string | null
  admin_nav_label: string | null
}

export interface PluginNavLink {
  href: string
  label: string
}

/**
 * The URL the shared plugin host actually serves a plugin's admin surface
 * at — derived from the plugin's `name`, never from the manifest's own
 * hand-written `ui_components[].path`.
 *
 * `services/_plugin-host/src/plugin_host/mount.py`'s `build_host` mounts a
 * declared `admin_ingress` at `Mount(f"/{name}/admin", ...)`, exposed
 * through Core at `/api/v1/plugins/<name>/admin`. The marketing plugin's
 * manifest instead declares `"path": "/admin/marketing"` — a portal route
 * that resolves to nothing (on tabsii dev it silently falls through to the
 * public marketing site). Trusting a hand-written string here would
 * reproduce that bug for the next plugin author who gets it wrong; deriving
 * it from `name` makes it impossible to get wrong.
 *
 * Deliberately **no trailing slash**, unlike `normalizeInstanceHref`'s
 * statically-exported portal routes. That normalisation exists because
 * Next's `trailingSlash: true` static export issues no redirect from the
 * unslashed form of an exported route, so a client-side nav to it renders
 * the route's raw RSC payload (issue #275) — a failure mode specific to
 * *this app's own* static file hosting. A plugin admin surface is served by
 * the API/Lambda through the shared plugin host, not by that static
 * export, so #275 doesn't apply to it. `mount.py`'s own
 * `_normalize_bare_admin_paths` documents the opposite constraint on that
 * side: the bare, no-slash form is the *only* one API Gateway has an
 * unauthenticated route for (biffo-template#631) — appending a slash here
 * would target a path the Gateway can't route at all.
 */
export function derivePluginAdminHref(name: string): string {
  return `/api/v1/plugins/${name}/admin`
}

/**
 * Filter and resolve plugin-declared nav entries, gated by the caller's
 * Cognito groups.
 *
 * Dropped, in the order checked: a missing/blank `name`; a plugin with no
 * declared admin surface (`has_admin_ingress` false — nothing to link to);
 * `has_admin_ingress` true but no `admin_required_group` (the API's own
 * `AdminIngress.required_group` validator rejects an empty string, so this
 * only fires on a malformed upstream response — fail **closed** rather than
 * render an ungated link, same posture as `cognito-groups.ts`); the
 * caller's groups don't include the required one (an absent/unreadable
 * group claim resolves to `[]` there, which satisfies nothing here either);
 * and a duplicate resolved `href` (first entry wins, same as the instance
 * contract).
 *
 * The manifest's declared `label` (surfaced as `admin_nav_label`) is used
 * for display text when present — trusted, unlike `path`, because a wrong
 * label degrades to a slightly-off word, not a broken link — falling back
 * to the plugin's `name`.
 */
export function resolvePluginNavLinks(
  plugins: readonly unknown[] | undefined,
  callerGroups: readonly string[] | undefined,
): PluginNavLink[] {
  if (plugins == null) return []
  const groups = new Set(callerGroups ?? [])
  const seen = new Set<string>()
  const resolved: PluginNavLink[] = []
  for (const raw of plugins) {
    // Deliberately re-typed as partial: this comes from a network response,
    // so the compiler's word that these fields are present is a promise
    // about the template's own types, not about what the API actually sent.
    const entry = raw as Partial<PluginNavSource> | null | undefined
    const name = entry?.name?.trim()
    if (name == null || name === '') continue
    if (entry?.has_admin_ingress !== true) continue
    const requiredGroup = entry.admin_required_group?.trim()
    if (requiredGroup == null || requiredGroup === '') continue
    if (!groups.has(requiredGroup)) continue
    const href = derivePluginAdminHref(name)
    if (seen.has(href)) continue
    seen.add(href)
    const declaredLabel = entry.admin_nav_label?.trim()
    resolved.push({
      href,
      label: declaredLabel != null && declaredLabel !== '' ? declaredLabel : name,
    })
  }
  return resolved
}
