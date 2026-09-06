import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// The tracked-link CloudFront viewer-request function is authored as a
// template (click-rewrite.js.tftpl) so main.tf can render it via
// templatefile() from the SAME CDN path contract this test reads — see
// path-contract.json and biffo-template#1923. Rendering it here the same way
// Terraform does (a single `${origin_path_prefix}` substitution) means this
// test executes the actual generated handler, not a hand-copied guess at
// what main.tf produces.
const repoRoot = join(__dirname, '..', '..', '..')
const cdnDir = join(repoRoot, 'modules', 'cloud', 'aws', 'cdn')

interface PathContractRow {
  key: string
  path_pattern: string
  origin: string
  origin_path_prefix: string
  token_required: boolean
  function: string
}

const contract: PathContractRow[] = JSON.parse(
  readFileSync(join(cdnDir, 'path-contract.json'), 'utf8'),
).rows
const clickRow = contract.find((r) => r.key === 'click')
if (!clickRow)
  throw new Error(
    'path-contract.json has no "click" row — cdn-click-rewrite-function.test.ts has nothing to test against',
  )
if (clickRow.function !== 'click-rewrite') {
  throw new Error(
    `path-contract.json's "click" row declares function=${clickRow.function}, not "click-rewrite" — either the contract or click-rewrite.js.tftpl has drifted`,
  )
}

// The template has exactly one substitution point: `${origin_path_prefix}`.
// This is deliberately the SAME single-variable substitution
// templatefile() performs — not a general template engine — so a template
// that ever needed more than this one value would need this test taught the
// same interpolation, keeping the two in lockstep by construction rather
// than by remembering to update both.
const template = readFileSync(join(cdnDir, 'click-rewrite.js.tftpl'), 'utf8')
const source = template.replaceAll('${origin_path_prefix}', clickRow.origin_path_prefix)

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
if (!handler)
  throw new Error('the rendered click-rewrite template did not define a top-level `handler`')

function run(uri: string, querystring: CfQueryString = {}): CfRequest {
  return handler!({ request: { uri, headers: {}, querystring } })
}

describe('cdn tracked-link rewrite — biffo-plugin-marketing#52', () => {
  it('rewrites /c/<token> to the origin path the contract declares', () => {
    const r = run('/c/abc123XYZ')
    expect(r.uri).toBe(`${clickRow.origin_path_prefix}/c/abc123XYZ`)
  })

  it('requires a token, per the contract row (token_required)', () => {
    expect(clickRow.token_required).toBe(true)
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
      expect(run(`/c/${token}`).uri).toBe(`${clickRow.origin_path_prefix}/c/${token}`)
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

  it('the rendered source contains no logging or network call that could leak a token', () => {
    // Belt-and-braces: CloudFront Functions has no console/network access in
    // its production runtime regardless, but assert the source never even
    // attempts one, so a future edit cannot introduce a channel that silently
    // does nothing in prod and leaks in any environment that does support it.
    expect(source).not.toMatch(/console\.|fetch\(|XMLHttpRequest/)
  })

  it('only ever writes request.uri — never replaces the request object wholesale', () => {
    const r = run('/c/abc123')
    expect(typeof r.uri).toBe('string')
    expect(r.uri.startsWith(clickRow.origin_path_prefix)).toBe(true)
  })

  it('the template has no leftover, un-substituted interpolation markers', () => {
    // If templatefile() were ever given a variable name this test doesn't
    // know about, `${origin_path_prefix}` above would substitute nothing for
    // it and the leftover `${...}` would silently reach CloudFront as
    // literal text. Guard the substitution itself, not just its result.
    expect(source).not.toContain('${')
  })
})
