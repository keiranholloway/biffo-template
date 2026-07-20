/**
 * Sibling microservices (ADR-0007) registered for this project. The list is a
 * static `siblings.json` generated at deploy time from the environment's
 * `siblings.auto.tfvars.json` (see .github/workflows/deploy-app.yml), so the
 * static portal can render the Microservices tab without a server round-trip.
 *
 * It is served from `/admin/siblings.json`, not the root. The portal owns the
 * `/admin` and `/login` prefixes and nothing else (issue #306) — `/` belongs to
 * the user-application sibling — so a manifest at the root would be answered by
 * a different origin entirely.
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

/** Path the deploy workflow publishes the manifest to. Must stay under `/admin`. */
export const SIBLINGS_MANIFEST_PATH = '/admin/siblings.json'

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
 */
export function siblingHref(name: string): string {
  return `/${name}`
}

/**
 * Same-origin link to one of a sibling's declared routes: `/<name>/<path>`, no
 * trailing slash (CloudFront's `<name>/*` behavior routes it to the sibling).
 */
export function siblingRouteHref(name: string, path: string): string {
  return `/${name}/${path}`
}
