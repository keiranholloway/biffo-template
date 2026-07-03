/**
 * Sanitises the `return_to` query param on the login page (ADR-0007) — a
 * sibling app redirects here as `/login?return_to=/<sibling-name>/` when it
 * finds no shared Cognito session, so login can send the user straight back
 * to where they came from instead of always landing on `/dashboard`.
 *
 * `return_to` is attacker-controllable (it's a query string), so this must
 * only ever accept a same-origin relative path — never an absolute URL —
 * or a crafted link could phish a user into a real login followed by a
 * redirect to an attacker-controlled site (open redirect).
 */
export function sanitizeReturnTo(raw: string | null, fallback = '/dashboard'): string {
  if (!raw) return fallback
  // Must start with exactly one "/" — "//evil.com" is protocol-relative
  // (browsers treat it as an absolute URL to a different host), and
  // anything containing "://" is already absolute.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('://')) {
    return fallback
  }
  return raw
}
