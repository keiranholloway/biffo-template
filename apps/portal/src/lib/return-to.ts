/**
 * Sanitises the `return_to` query param on the login page (ADR-0007) — a
 * sibling app redirects here as `/login/?return_to=/<sibling-name>/` when it
 * finds no shared Cognito session, so login can send the user straight back
 * to where they came from instead of always landing on the dashboard.
 *
 * `return_to` is attacker-controllable (it's a query string), so this must
 * only ever accept a same-origin relative path — never an absolute URL —
 * or a crafted link could phish a user into a real login followed by a
 * redirect to an attacker-controlled site (open redirect).
 */

/**
 * The portal builds with `output: 'export'` and `trailingSlash: true`, so the
 * canonical URL of every route ends in `/` and its App Router RSC payload is
 * emitted alongside the HTML as `<route>/index.txt`.
 *
 * A client-side navigation to the *unslashed* form resolves onto that payload
 * file, and the browser lands on `/admin/index.txt` showing raw serialised
 * React instead of the page. On a Next server a redirect to the canonical form
 * would fix this in flight; static hosting has no such redirect — S3/CloudFront
 * answer `/admin` with `200 index.html` directly — so the mismatch is never
 * corrected and the client router is left to resolve it wrongly.
 *
 * Static hrefs are written with their trailing slash. `return_to` cannot be:
 * it arrives from a sibling app or a hand-built link, so it is normalised here.
 */
function withTrailingSlash(path: string): string {
  // Split off query/hash first — "/admin?tab=1" must become "/admin/?tab=1",
  // never "/admin?tab=1/".
  const match = /^([^?#]*)(.*)$/.exec(path)
  const pathname = match?.[1] ?? path
  const suffix = match?.[2] ?? ''

  if (pathname.endsWith('/')) return path

  // A final segment containing a dot is a file, not a route — "/logo.svg" and
  // "/admin/index.txt" must be left exactly as given.
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1)
  if (lastSegment.includes('.')) return path

  return `${pathname}/${suffix}`
}

export function sanitizeReturnTo(raw: string | null, fallback = '/admin/'): string {
  if (!raw) return fallback
  // Must start with exactly one "/" — "//evil.com" is protocol-relative
  // (browsers treat it as an absolute URL to a different host), and
  // anything containing "://" is already absolute.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('://')) {
    return fallback
  }
  // Normalise only after the origin checks above have passed, so nothing here
  // can turn a rejected value into an accepted one.
  return withTrailingSlash(raw)
}

/**
 * The URL prefix the portal itself owns and serves. Its routes live under
 * `/admin` — the portal is a standalone Next.js app whose `next.config.ts`
 * sets `assetPrefix: '/admin'` (issue #306), so `/admin` and `/admin/*` are
 * the only paths its client router can resolve against its own RSC payloads.
 *
 * Anything else a sanitised `return_to` can carry — most commonly the root
 * sibling at `/` (ADR-0007), or `/<sibling>/` — belongs to a *different*
 * Next.js app on a different S3 origin. See `isWithinPortal` for why the
 * distinction decides how the post-login redirect must be performed.
 */
export const PORTAL_BASE_PATH = '/admin'

/**
 * True when `path` is a route this portal owns (under `PORTAL_BASE_PATH`),
 * i.e. one its own client router can navigate to.
 *
 * This gates the post-login redirect (issue #351). A client-side
 * `router.push(returnTo)` is only correct for in-portal targets: for a sibling
 * route the portal router would fetch that route's RSC flight payload
 * (`/index.txt` for `/`) and try to render it within the portal, across an app
 * boundary that a static export can only cross with a full page load — so the
 * browser lands on the raw serialised React instead of the app (the #275
 * failure class, now cross-app). A sibling target must therefore use a
 * full-page `window.location.assign` instead.
 */
export function isWithinPortal(path: string, basePath: string = PORTAL_BASE_PATH): boolean {
  // Compare on the pathname only — a query string or hash must not fool the
  // prefix check (e.g. "/?next=/admin" is a sibling route, not a portal one).
  const pathname = /^([^?#]*)/.exec(path)?.[1] ?? path
  return pathname === basePath || pathname.startsWith(`${basePath}/`)
}
