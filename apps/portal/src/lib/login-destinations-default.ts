/**
 * The fallback `@/instance-login-destinations` resolves to when an instance has
 * not declared one — **template-owned**, and the reason
 * `src/instance-login-destinations.ts` is optional (#1098, ADR-0028's pattern).
 *
 * The same asymmetry `instance-nav-empty.ts` documents applies: template-owned
 * `login-routing.ts` imports this specifier *statically*, a bundler resolves
 * static imports at build time and cannot degrade, so without a fallback every
 * instance would have to carry the file — and any instance created before this
 * seam would fail `module not found` on its next `core upgrade`, because
 * `core upgrade` deliberately never carries user-owned paths.
 *
 * ## Why these values, and why not `/crm/`
 *
 * Every destination here must exist in a **fresh** Biffo instance, which is the
 * bug this seam fixes: `/crm/`, `/lms/` and `/marketplace/` are tabsii sibling
 * apps, and an instance without them routed every authenticated user to a 404.
 *
 * `/admin/` and `/login/no-access/` are template routes and always exist. Every
 * other outcome falls back to `/admin/` rather than to a surface that may not be
 * there: a user who reaches it either belongs (and `AuthGuard` admits them) or
 * does not (and is refused with an explanation), which is a worse landing page
 * than a bespoke one but never a 404 and never a blank screen.
 *
 * **Do not add product surfaces here.** An instance's destinations belong in its
 * own user-owned `src/instance-login-destinations.ts`; putting `/crm/` back in
 * this file is exactly the seam violation #1098 records.
 */
import type { LoginDestinations } from '@/lib/login-destinations-contract'

export const INSTANCE_LOGIN_DESTINATIONS: Partial<LoginDestinations> = {}

/**
 * What every rule resolves to before an instance overrides anything.
 *
 * Kept separate from the (empty) instance declaration above so
 * `normalizeLoginDestinations` always has a complete map to fall back to,
 * key by key — a partial override must not be able to leave a rule undefined.
 */
export const DEFAULT_LOGIN_DESTINATIONS: LoginDestinations = {
  admin: '/admin/',
  platformAdmin: '/admin/',
  orgScoped: '/admin/',
  unitScoped: '/admin/',
  marketplace: '/admin/',
  noAccess: '/login/no-access/',
}
