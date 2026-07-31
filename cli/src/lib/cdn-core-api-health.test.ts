import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(__dirname, '..', '..', '..')
const cdnMainTf = join(repoRoot, 'modules', 'cloud', 'aws', 'cdn', 'main.tf')

/**
 * The Core API health route through CloudFront.
 *
 * Without an API behaviour, `baseurl.com/api/v1/health` falls through to
 * `default_cache_behavior` — the user-application sibling's static bucket — and
 * returns that app's HTML with a 403. Observed live: the API answered correctly
 * on its gateway URL while the public domain served the portal's markup.
 *
 * That failure is silent in the worst way. A health check pointed at the public
 * domain does not error; it reads a static site and reports on *that*. It can
 * say "down" while the API is healthy, or "up" while the API is unreachable,
 * and neither answer is about the API at all.
 *
 * Reads the real module rather than a fixture, for the same reason
 * `cdn-error-status-guard.test.ts` does: the invariant is about what this
 * distribution actually ships.
 */
function cdn(): string {
  return readFileSync(cdnMainTf, 'utf8')
}

/** The `ordered_cache_behavior` block whose for_each mentions `needle`. */
function behaviourFor(needle: string): string | null {
  const blocks = cdn()
    .split(/dynamic\s+"ordered_cache_behavior"\s*\{/)
    .slice(1)
  return blocks.find((b) => b.split('\n').slice(0, 6).join('\n').includes(needle)) ?? null
}

describe('CloudFront routes the Core API health endpoint', () => {
  it('declares a core-api origin, gated on the variable', () => {
    const tf = cdn()
    expect(tf).toContain('origin_id   = "core-api"')
    // Gated: an instance that does not set the variable gets no origin at all,
    // so this cannot silently add an API origin to every distribution.
    expect(tf).toMatch(
      /var\.core_api_health_domain == "" \? \[\] : \[var\.core_api_health_domain\]/,
    )
  })

  it('routes exactly api/v1/health to it', () => {
    const block = behaviourFor('core-api')
    expect(block).not.toBeNull()
    expect(block).toContain('"api/v1/health" = "core-api"')
  })

  it('does NOT route the whole api/v1 prefix', () => {
    // Routing everything is a deliberate non-goal: it would put every
    // authenticated endpoint behind the CDN at once and change caching, header
    // forwarding and the auth surface together. If someone widens this, it
    // should be a decision, not a diff nobody noticed.
    expect(cdn()).not.toContain('"api/v1/*"')
  })

  it('disables caching — a cached health response is not a health check', () => {
    const block = behaviourFor('core-api') ?? ''
    expect(block).toContain('caching_disabled')
  })

  it('is read-only: no write methods on a health route', () => {
    const block = behaviourFor('core-api') ?? ''
    const allowed = /allowed_methods\s*=\s*\[([^\]]*)\]/.exec(block)?.[1] ?? ''
    for (const write of ['PUT', 'POST', 'PATCH', 'DELETE']) {
      expect(allowed).not.toContain(write)
    }
    expect(allowed).toContain('GET')
  })

  it('attaches no rewrite function, which would mangle the API request', () => {
    // The viewer-request function rewrites clean URLs to index.html for the
    // static exports. On an API path it would rewrite the request away.
    const block = behaviourFor('core-api') ?? ''
    expect(block).not.toContain('function_association')
  })
})
