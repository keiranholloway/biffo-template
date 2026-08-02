/**
 * Sibling microservices (ADR-0007) registered for this project. The list is a
 * static `siblings.json` generated at deploy time from the environment's
 * `siblings.auto.tfvars.json` (see .github/workflows/deploy-app.yml), so the
 * static portal can render the Microservices tab without a server round-trip.
 *
 * It is served from `/.well-known/siblings.json`, not the root and not
 * `/admin` (tabsii-platform#508). The portal owns only the `/admin` and
 * `/login` prefixes (issue #306) — `/` belongs to the user-application
 * sibling, so a manifest at the bare root would be answered by a different
 * origin entirely. `/admin` would work (the portal owns it) but makes this a
 * portal-private file in name only: every other sibling is meant to depend on
 * this manifest too, not just the portal's own Microservices tab, so it needs
 * a path that reads as a stable cross-app contract rather than an admin
 * implementation detail. `/.well-known/*` already exists as its own CDN
 * behaviour (modules/cloud/aws/cdn/main.tf), built for the runtime identity
 * document (#403) and reused here for the same reason: it points at the
 * portal's own S3 origin, is excluded from the SPA rewrite, and gets a short
 * TTL rather than the portal's normal immutable asset caching.
 */

/** A notable route a sibling exposes, declared in its `biffo.sibling.json`. */
export interface SiblingRoute {
  /** Sub-path relative to the sibling's prefix, no leading slash (e.g. `demo`). */
  path: string
  /** Human label shown on the card (e.g. `Book a demo`). */
  label: string
}

export interface Sibling {
  /** Routing/display name — also the CloudFront path segment. */
  name: string
  description: string
  /**
   * Notable routes the sibling declares (ADR-0007). Optional — a sibling with
   * none just shows its single root link. Populated from the sibling's own
   * `biffo.sibling.json` via the core's `siblings.auto.tfvars.json`.
   */
  routes?: SiblingRoute[]
}

/** Path the deploy workflow publishes the manifest to (tabsii-platform#508). */
export const SIBLINGS_MANIFEST_PATH = '/.well-known/siblings.json'

/**
 * The reserved registry name for the ROOT application sibling (issue #306),
 * kept in lockstep with `local.root_sibling_name` in
 * `modules/cloud/aws/cdn/main.tf`. It is a real, non-empty `sibling_origins[]`
 * name (an empty name would break origin ids and CLI teardown lookup), but its
 * PATH PREFIX is empty — the CDN module deliberately gives it
 * `default_cache_behavior` instead of the usual `"app"`/`"app/*"` ordered
 * behaviors, specifically so the literal URL `/app` is never claimed by it.
 * A generic `/${name}` link would therefore point at a path CloudFront never
 * routes to this sibling (it falls through to the same origin only by
 * accident, via the default 404 catch-all) instead of its real address, `/`.
 */
export const ROOT_SIBLING_NAME = 'app'

/** Fetch the registered siblings for this deployment. */
export async function fetchSiblings(): Promise<Sibling[]> {
  const res = await fetch(SIBLINGS_MANIFEST_PATH, { cache: 'no-store' })
  if (!res.ok) {
    throw new Error(`Could not load microservices (${String(res.status)})`)
  }
  // siblings is optional in the parse so a malformed/empty manifest degrades to [].
  const data = (await res.json()) as { siblings?: Sibling[] }
  return data.siblings ?? []
}

/**
 * Same-origin path link to a sibling. **No trailing slash** — CloudFront routes
 * `baseurl/<name>` exactly, and a trailing slash has bitten us before (e.g.
 * `/cms` works, `/cms/` does not). This is the clickable *entry point*.
 *
 * The root sibling (`ROOT_SIBLING_NAME`) is the one exception: its real address
 * is `/`, never `/app` — see `ROOT_SIBLING_NAME`'s own comment for why.
 */
export function siblingHref(name: string): string {
  return name === ROOT_SIBLING_NAME ? '/' : `/${name}`
}

/**
 * Same-origin link to one of a sibling's declared routes: `/<name>/<path>`, no
 * trailing slash (CloudFront's `<name>/*` behavior routes it to the sibling).
 *
 * For the root sibling this omits the name entirely (`/<path>`, not
 * `/app/<path>`) for the same reason as `siblingHref`.
 */
export function siblingRouteHref(name: string, path: string): string {
  return name === ROOT_SIBLING_NAME ? `/${path}` : `/${name}/${path}`
}
