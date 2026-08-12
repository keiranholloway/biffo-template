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
  it('declares a core-api origin, gated on the resolved domain', () => {
    const tf = cdn()
    expect(tf).toContain('origin_id   = "core-api"')
    // Still gated — an instance enabling neither Core-API route gets no origin
    // at all, so this cannot silently add an API origin to every distribution.
    //
    // The gate widened when tracked links became a second consumer. It used to
    // read `var.core_api_health_domain` directly, which was correct while that
    // was the only behaviour using the origin; with two independently opt-in
    // behaviours it would leave an instance wanting tracked links but not the
    // health route pointing a behaviour at an origin that does not exist —
    // which fails the apply and takes the whole distribution down, portal
    // included.
    expect(tf).toMatch(
      /local\.core_api_origin_domain == "" \? \[\] : \[local\.core_api_origin_domain\]/,
    )
  })

  it('resolves that origin from EITHER Core-API variable', () => {
    // The property the gate above depends on: the local must consider every
    // variable that can enable a core-api behaviour. A new behaviour added
    // later without extending this local reintroduces exactly the
    // origin-does-not-exist failure the widening was for, and the apply error
    // names neither the behaviour nor the variable.
    const tf = cdn()
    const local = tf.match(/core_api_origin_domain\s*=\s*try\(([\s\S]*?)\)\n/)?.[1] ?? ''
    expect(local).toContain('var.core_api_health_domain')
    expect(local).toContain('var.tracked_link_api_domain')
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

  it('attaches no viewer-request rewrite function, which would mangle the API request', () => {
    // The viewer-request function rewrites clean URLs to index.html for the
    // static exports. On an API path it would rewrite the request away. This
    // behaviour DOES carry a viewer-RESPONSE function_association since
    // biffo-template#1529 (error-status-restore.js, gated on
    // error_status_restore_lambda_arn) — that one only ever reads/writes a
    // status code and one header, never the request, so it doesn't
    // reintroduce the hazard this test guards against. Assert on the
    // specific function rather than the presence of any
    // function_association/lambda_function_association block, since #1529
    // legitimately added those.
    const block = behaviourFor('core-api') ?? ''
    expect(block).not.toContain('aws_cloudfront_function.rewrite.arn')
    expect(block).not.toContain('event_type   = "viewer-request"')
  })
})
