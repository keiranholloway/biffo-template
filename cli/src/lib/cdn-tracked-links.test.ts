import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(__dirname, '..', '..', '..')
const cdnMainTf = join(repoRoot, 'modules', 'cloud', 'aws', 'cdn', 'main.tf')
const cdnVariablesTf = join(repoRoot, 'modules', 'cloud', 'aws', 'cdn', 'variables.tf')

/**
 * Tracked marketing links — `baseurl.com/c/<token>` to the Core API, which
 * records the click and redirects to the campaign destination.
 *
 * Reads the real module rather than a fixture, like its sibling guards: the
 * invariant is about what this distribution actually ships.
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

describe('CloudFront routes tracked marketing links', () => {
  it('routes c/* to the core-api origin, gated on its own variable', () => {
    const block = behaviourFor('"c/*"')
    expect(block).not.toBeNull()
    expect(block).toContain('"c/*" = "core-api"')
    expect(block).toContain('var.tracked_link_api_domain == ""')
  })

  it('does NOT cache the redirect', () => {
    // The load-bearing assertion in this file.
    //
    // A cached redirect is served by CloudFront without ever reaching the
    // origin, so every click after the first is never recorded. Nothing errors,
    // the link still works, and the campaign silently undercounts — the failure
    // mode that looks like success, which is the expensive kind.
    //
    // Caching this would also be a plausible "optimisation": a 302 to a fixed
    // destination looks eminently cacheable if you do not know the request IS
    // the measurement.
    const block = behaviourFor('"c/*"')
    expect(block).toContain('data.aws_cloudfront_cache_policy.caching_disabled.id')
    expect(block).not.toContain('caching_optimized')
  })

  it('does not attach the static-export rewrite function', () => {
    // rewrite.js rewrites clean URLs to index.html for static export. Applied
    // here it would turn every tracked link into a request for the SPA shell,
    // and the redirect would never happen. This asserted "no
    // function_association at all" until biffo-plugin-marketing#52: that was
    // the bug, not the fix — see the next test.
    const block = behaviourFor('"c/*"')
    expect(block).not.toContain('aws_cloudfront_function.rewrite.arn')
  })

  it('attaches its own click-rewrite function, viewer-request, to reach the API route it actually declares', () => {
    // Without this, CloudFront forwards the viewer path unchanged: a request
    // for `/c/<token>` asks API Gateway for exactly `/c/<token>`, which
    // matches no declared route (the API only declares
    // `GET /api/v1/public/c/{token}`) and falls through to $default, which
    // requires a Cognito JWT — every tracked link 401ed instead of
    // redirecting (biffo-plugin-marketing#52). click-rewrite.js is the fix;
    // its own test (cdn-click-rewrite-function.test.ts) covers the rewrite
    // logic and the security properties it must preserve.
    const block = behaviourFor('"c/*"')
    expect(block).toContain('aws_cloudfront_function.click_rewrite')
    expect(block).toMatch(/event_type\s*=\s*"viewer-request"/)
  })

  it('gates the click-rewrite function behind the same opt-in guard as the behaviour', () => {
    // The feature must stay fully opt-in end to end: an instance without
    // tracked links gets no behaviour AND no function resource, not an inert
    // one sitting unused.
    const fnBlock = cdn().split('resource "aws_cloudfront_function" "click_rewrite"')[1] ?? ''
    const declaration = fnBlock.split('\n').slice(0, 10).join('\n')
    expect(declaration).toContain('count   = var.tracked_link_api_domain == "" ? 0 : 1')
  })

  it('allows only read methods', () => {
    // Following a link is a GET. A tracked link that accepted POST would be an
    // unauthenticated write surface reachable from any published URL.
    const block = behaviourFor('"c/*"')
    expect(block).toContain('allowed_methods          = ["GET", "HEAD", "OPTIONS"]')
  })

  it('reserves "c" as a sibling name', () => {
    // Enabling this claims the c/* prefix. A sibling of the same name would
    // produce two behaviours sharing a path_pattern — CloudFront rejects that
    // rather than silently shadowing one, but it fails at apply with a message
    // naming neither the sibling nor this feature, so it is caught at the
    // variable where the cause is legible.
    const variables = readFileSync(cdnVariablesTf, 'utf8')
    expect(variables).toMatch(/contains\(\[[^\]]*"c"[^\]]*\], s\.name\)/)
  })

  it('rejects a domain carrying a scheme or path', () => {
    // Getting this wrong fails at apply with a CloudFront origin error that
    // never names the variable that caused it.
    const variables = readFileSync(cdnVariablesTf, 'utf8')
    const block = variables.split('variable "tracked_link_api_domain"')[1] ?? ''
    expect(block).toContain('can(regex("^[a-z0-9.-]+$", var.tracked_link_api_domain))')
  })

  it('defaults to empty, so no distribution gains the prefix by accident', () => {
    const variables = readFileSync(cdnVariablesTf, 'utf8')
    const block = variables.split('variable "tracked_link_api_domain"')[1] ?? ''
    expect(block).toMatch(/default\s*=\s*""/)
  })
})
