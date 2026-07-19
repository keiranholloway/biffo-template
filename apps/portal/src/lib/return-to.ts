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
