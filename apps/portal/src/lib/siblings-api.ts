/**
 * Sibling microservices (ADR-0007) registered for this project. The list is a
 * static `siblings.json` generated at deploy time from the environment's
 * `siblings.auto.tfvars.json` (see .github/workflows/deploy-app.yml), so the
 * static portal can render the Microservices tab without a server round-trip.
 */

export interface Sibling {
  /** Routing/display name — also the CloudFront path segment. */
  name: string
  description: string
}

/** Fetch the registered siblings for this deployment. */
export async function fetchSiblings(): Promise<Sibling[]> {
  const res = await fetch('/siblings.json', { cache: 'no-store' })
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
 * `/cms` works, `/cms/` does not).
 */
export function siblingHref(name: string): string {
  return `/${name}`
}
