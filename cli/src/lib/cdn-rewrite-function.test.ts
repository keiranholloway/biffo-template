import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// The CloudFront viewer-request function is authored as standalone JS so it can
// be executed here. It is CloudFront Functions source (a top-level `function
// handler`), not an ES module, so load it the way CloudFront does: evaluate the
// body in a fresh context and pull `handler` off that context's globals.
//
// Unlike click-rewrite.js.tftpl, this function's logic has no contract-derived
// VALUE to substitute — it applies the same directory/RSC-self-heal rewrite to
// any URI, regardless of which origin or contract row it's associated with, so
// it stays a plain file() load in main.tf (see path-contract.json's header).
// What DOES come from the CDN path contract (biffo-template#1923) is which
// literal path prefixes below are worth exercising: derived from the contract
// rather than re-typed, so a renamed or added "rewrite"-function row is
// automatically covered here without anyone remembering to update this file.
const repoRoot = join(__dirname, '..', '..', '..')
const cdnDir = join(repoRoot, 'modules', 'cloud', 'aws', 'cdn')
const source = readFileSync(join(cdnDir, 'rewrite.js'), 'utf8')

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

// The "bare" (non-wildcard) path patterns whose behaviour attaches
// rewrite.js as its viewer-request function — "admin", "login" today. Used
// to build realistic sub-paths under each prefix (e.g. "admin/microservices")
// rather than hardcoding those prefix names directly.
const rewriteFunctionBases = contract
  .filter((r) => r.function === 'rewrite' && !r.path_pattern.includes('*'))
  .map((r) => r.path_pattern)
if (rewriteFunctionBases.length === 0) {
  throw new Error(
    'path-contract.json has no bare "rewrite" row — this test has no contract-governed prefix to exercise',
  )
}
const [primaryBase, secondaryBase] = rewriteFunctionBases
if (!primaryBase || !secondaryBase) {
  throw new Error(
    `path-contract.json's "rewrite" rows changed shape — expected at least two bare prefixes (got: ${JSON.stringify(rewriteFunctionBases)}), and this test's two-prefix cases need updating to match`,
  )
}

interface CfHeaders {
  [name: string]: { value: string }
}
// CloudFront hands the query string over as its own object — never as part of
// `uri`, and never as a raw string. A repeated key arrives as `multiValue`.
interface CfQueryString {
  [name: string]: { value?: string; multiValue?: { value: string }[] }
}
interface CfRequest {
  uri: string
  headers: CfHeaders
  querystring: CfQueryString
}
interface CfResponse {
  statusCode: number
  statusDescription: string
  headers: CfHeaders
}
type CfResult = CfRequest | CfResponse

const sandbox: { handler?: (event: { request: CfRequest }) => CfResult } = {}
runInNewContext(source, sandbox)
const handler = sandbox.handler
if (!handler) throw new Error('rewrite.js did not define a top-level `handler`')

function run(uri: string, headers: CfHeaders = {}, querystring: CfQueryString = {}): CfResult {
  return handler!({ request: { uri, headers, querystring } })
}
function isResponse(r: CfResult): r is CfResponse {
  return 'statusCode' in r
}
const document: CfHeaders = { 'sec-fetch-dest': { value: 'document' } }
const rscFetch: CfHeaders = { 'sec-fetch-dest': { value: 'empty' } }

describe('cdn rewrite function — RSC .txt self-heal', () => {
  it('redirects a document navigation of a route payload to its clean route', () => {
    for (const [txt, clean] of [
      [`/${primaryBase}/microservices/index.txt`, `/${primaryBase}/microservices/`],
      [`/${secondaryBase}/index.txt`, `/${secondaryBase}/`],
      ['/index.txt', '/'], // root sibling — not a contract row; the default behaviour's own origin
    ] as const) {
      const r = run(txt, document)
      expect(isResponse(r)).toBe(true)
      if (!isResponse(r)) continue
      expect(r.statusCode).toBe(302)
      expect(r.headers.location?.value).toBe(clean)
      // Regression check: with no query string on the original request the
      // Location must not gain a stray trailing "?".
      expect(r.headers.location?.value).not.toContain('?')
      // The redirect itself must not be cached — it exists to break a skew.
      expect(r.headers['cache-control']?.value).toBe('no-store')
    }
  })

  it('preserves a single-key query string on the redirect Location (issue #961)', () => {
    // e.g. a marketplace's /brand/?slug=northfield-coffee-co — Next's own
    // RSC-fetch error recovery falls back to a document navigation of
    // /brand/index.txt?slug=northfield-coffee-co, which this function must
    // redirect back to /brand/?slug=northfield-coffee-co, not the bare /brand/.
    const r = run('/brand/index.txt', document, { slug: { value: 'northfield-coffee-co' } })
    expect(isResponse(r)).toBe(true)
    if (!isResponse(r)) return
    expect(r.statusCode).toBe(302)
    expect(r.headers.location?.value).toBe('/brand/?slug=northfield-coffee-co')
  })

  it('preserves a multi-value (repeated) query key on the redirect Location', () => {
    const r = run('/brand/index.txt', document, {
      tag: { multiValue: [{ value: 'coffee' }, { value: 'roastery' }] },
    })
    expect(isResponse(r)).toBe(true)
    if (!isResponse(r)) return
    expect(r.headers.location?.value).toBe('/brand/?tag=coffee&tag=roastery')
  })

  it('preserves multiple distinct query keys together, URL-encoded', () => {
    const r = run('/brand/index.txt', document, {
      slug: { value: 'northfield-coffee-co' },
      ref: { value: 'a b&c' },
    })
    expect(isResponse(r)).toBe(true)
    if (!isResponse(r)) return
    expect(r.headers.location?.value).toBe('/brand/?slug=northfield-coffee-co&ref=a%20b%26c')
  })

  it('lets the router’s own RSC fetch of a .txt payload pass straight through', () => {
    const uri = `/${primaryBase}/microservices/index.txt`
    const r = run(uri, rscFetch)
    expect(isResponse(r)).toBe(false)
    if (isResponse(r)) return
    // Untouched: it still has a dot, so the index.html rewrite leaves it alone.
    expect(r.uri).toBe(uri)
  })

  it('does not redirect a .txt when Sec-Fetch-Dest is absent (never breaks a fetch)', () => {
    const uri = `/${primaryBase}/users/index.txt`
    const r = run(uri)
    expect(isResponse(r)).toBe(false)
    if (isResponse(r)) return
    expect(r.uri).toBe(uri)
  })
})

describe('cdn rewrite function — directory index rewrite (preserved)', () => {
  it('maps directory-style routes to their static index.html', () => {
    for (const [input, expected] of [
      [`/${primaryBase}/users/`, `/${primaryBase}/users/index.html`],
      [`/${secondaryBase}`, `/${secondaryBase}/index.html`],
      ['/', '/index.html'],
    ] as const) {
      const r = run(input, document)
      expect(isResponse(r)).toBe(false)
      if (isResponse(r)) continue
      expect(r.uri).toBe(expected)
    }
  })

  it('leaves requests for real files (with an extension) untouched', () => {
    for (const asset of [
      `/${primaryBase}/_next/static/chunks/main-app-c261856d15d797e9.js`,
      `/${primaryBase}/_next/static/css/a14000bdc46f5e67.css`,
      `/${primaryBase}/logo.svg`,
    ]) {
      const r = run(asset, document)
      expect(isResponse(r)).toBe(false)
      if (isResponse(r)) continue
      expect(r.uri).toBe(asset)
    }
  })
})

describe('cdn path contract — rewrite rows (biffo-template#1923)', () => {
  it('every bare "rewrite" row has a matching "<pattern>/*" wildcard row', () => {
    // main.tf's own comment on portal_cache_behaviors: CloudFront's
    // path_pattern "<name>/*" does not match the bare "/<name>", so every
    // prefix this test exercises needs both forms wired — assert the
    // contract itself preserves that pairing rather than trusting it stayed
    // true by accident.
    for (const base of rewriteFunctionBases) {
      const wildcard = contract.find(
        (r) => r.function === 'rewrite' && r.path_pattern === `${base}/*`,
      )
      expect(wildcard, `expected a "${base}/*" row alongside the bare "${base}" row`).toBeDefined()
    }
  })
})
