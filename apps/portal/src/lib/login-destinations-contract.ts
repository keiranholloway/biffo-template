/**
 * The contract between the template-owned post-login **rules** and an
 * instance's own **surface paths** (#1098, following ADR-0028's seam).
 *
 * ## Why this exists
 *
 * `login-routing.ts` is template-owned and its rule table returned
 * instance-specific paths — `/crm/` and `/marketplace/`, which are tabsii
 * sibling apps. **A fresh Biffo instance has none of them**, so its login sent
 * every authenticated user to a 404.
 *
 * It surfaced when tabsii wanted to change a rule's destination and the
 * instance's core-ownership guard correctly refused, meaning a template release
 * would have carried a tabsii product decision that every other instance
 * inherits. The guard did its job; what it revealed is that the file was on the
 * wrong side of the seam.
 *
 * ## The split
 *
 * The **rules** stay template-owned — which scope level wins, and in what order
 * — because that is the part with real behaviour in it and the part worth
 * testing upstream. The **destinations** become instance-owned data, because
 * which surface serves a unit-scoped user is a product decision per instance.
 *
 * Keys are named for the *outcome*, never for a surface: `orgScoped` rather
 * than `crm`. A key called `crm` would put the same product decision back in
 * template-owned code with an extra step.
 *
 * See `login-destinations-default.ts` for what an instance that declares
 * nothing gets, and `@/instance-login-destinations` for how an instance
 * overrides it.
 */

/**
 * Where each post-login rule sends a user.
 *
 * Every value is an internal portal path. `resolveDestination` returns them
 * verbatim, so they must be canonical for this app's `trailingSlash: true`
 * static export — a client-side navigation to an unslashed statically-exported
 * route lands on the route's RSC payload and renders raw serialised React
 * (#275). `normalizeLoginDestinations` below does that for you.
 */
export interface LoginDestinations {
  /** Rule 2 — the user is in the `admin` Cognito group. */
  admin: string
  /** Rule 3 — `whoami.is_platform_admin`. */
  platformAdmin: string
  /** Rule 4 — a role scoped at `tenant`, `brand` or `region`. */
  orgScoped: string
  /** Rule 5 — a role scoped at `unit`. */
  unitScoped: string
  /** Rule 6 — `marketplace_role` set and no roles at all. */
  marketplace: string
  /** Rule 7 — no rule matched. */
  noAccess: string
}

/**
 * Canonicalise every destination for `trailingSlash: true`.
 *
 * The same job `normalizeInstanceHref` does for nav entries, and for the same
 * reason: these are **data** supplied by an instance, so the literal-href
 * scanner in `internal-links.test.ts` cannot see them. Normalising here beats
 * trusting every instance to remember (#275).
 *
 * Deliberately does NOT fail-soft the way the nav seam does. A dropped nav link
 * costs one menu entry; a dropped login destination would leave a rule with
 * nowhere to send a user, which is the 404 this whole seam exists to remove. A
 * value that is not an internal absolute path is a mistake worth surfacing, so
 * it falls back to the template default for that key rather than to `undefined`.
 */
export function normalizeLoginDestinations(
  declared: Partial<LoginDestinations>,
  fallback: LoginDestinations,
): LoginDestinations {
  const out = { ...fallback }
  for (const key of Object.keys(fallback) as (keyof LoginDestinations)[]) {
    const value = declared[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    // Internal absolute paths only. An external URL here would be an open
    // redirect on the one code path that runs for every user at login.
    if (!trimmed.startsWith('/') || trimmed.startsWith('//')) continue
    out[key] = trimmed.endsWith('/') ? trimmed : `${trimmed}/`
  }
  return out
}
