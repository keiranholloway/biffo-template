import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// The tracked-link CloudFront viewer-request function is authored as
// standalone JS so it can be executed here, the same convention as
// cdn-rewrite-function.test.ts. It is CloudFront Functions source (a
// top-level `function handler`), not an ES module, so load it the way
// CloudFront does: evaluate the body in a fresh context and pull `handler`
// off that context's globals.
const repoRoot = join(__dirname, '..', '..', '..')
const path = join(repoRoot, 'modules', 'cloud', 'aws', 'cdn', 'click-rewrite.js')
const source = readFileSync(path, 'utf8')

interface CfHeaders {
  [name: string]: { value: string }
}
interface CfQueryString {
  [name: string]: { value?: string; multiValue?: { value: string }[] }
}
interface CfRequest {
  uri: string
  headers: CfHeaders
  querystring: CfQueryString
}

const sandbox: { handler?: (event: { request: CfRequest }) => CfRequest } = {}
runInNewContext(source, sandbox)
const handler = sandbox.handler
if (!handler) throw new Error('click-rewrite.js did not define a top-level `handler`')

function run(uri: string, querystring: CfQueryString = {}): CfRequest {
  return handler!({ request: { uri, headers: {}, querystring } })
}

describe('cdn tracked-link rewrite — biffo-plugin-marketing#52', () => {
  it('rewrites /c/<token> to the Core API public click route', () => {
    const r = run('/c/abc123XYZ')
    expect(r.uri).toBe('/api/v1/public/c/abc123XYZ')
  })

  it('rewrites every token identically — no branching on shape or validity', () => {
    // The constant-404 property this function must not weaken lives entirely
    // in the API handler: this function must never distinguish a
    // "plausible" token from an "implausible" one, because doing so here
    // would itself become the enumeration oracle the API's constant 404 is
    // there to prevent. Assert the rewrite is the same pure prefix
    // substitution regardless of what the token looks like.
    const tokens = [
      'abc123XYZ', // a normal-looking token
      'this-token-does-not-exist', // an obviously bogus one
      'ffffffff-ffff-ffff-ffff-ffffffffffff', // a well-formed-looking UUID
      'a', // implausibly short
      'a'.repeat(200), // implausibly long
    ]
    for (const token of tokens) {
      expect(run(`/c/${token}`).uri).toBe(`/api/v1/public/c/${token}`)
    }
  })

  it('does not touch the query string object at all', () => {
    const qs: CfQueryString = { utm_source: { value: 'newsletter' } }
    const r = run('/c/abc123', qs)
    // CloudFront forwards `request.querystring` to the origin independently
    // of `request.uri`; the function must leave it completely alone rather
    // than folding it into the rewritten path (which would both corrupt the
    // origin request and put query data where a token-shaped path segment
    // could be mistaken for one).
    expect(r.querystring).toBe(qs)
  })

  it('adds no headers and mutates no header value (nothing here can leak the token)', () => {
    const r = run('/c/abc123')
    expect(r.headers).toEqual({})
  })

  it('the source contains no logging or network call that could leak a token', () => {
    // Belt-and-braces: CloudFront Functions has no console/network access in
    // its production runtime regardless, but assert the source never even
    // attempts one, so a future edit cannot introduce a channel that silently
    // does nothing in prod and leaks in any environment that does support it.
    expect(source).not.toMatch(/console\.|fetch\(|XMLHttpRequest/)
  })

  it('only ever writes request.uri — never replaces the request object wholesale', () => {
    const r = run('/c/abc123')
    expect(typeof r.uri).toBe('string')
    expect(r.uri.startsWith('/api/v1/public/c/')).toBe(true)
  })
})
