import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// The CloudFront viewer-request function is authored as standalone JS so it can
// be executed here. It is CloudFront Functions source (a top-level `function
// handler`), not an ES module, so load it the way CloudFront does: evaluate the
// body in a fresh context and pull `handler` off that context's globals.
const repoRoot = join(__dirname, '..', '..', '..')
const source = readFileSync(join(repoRoot, 'modules', 'cloud', 'aws', 'cdn', 'rewrite.js'), 'utf8')

interface CfHeaders {
  [name: string]: { value: string }
}
interface CfRequest {
  uri: string
  headers: CfHeaders
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

function run(uri: string, headers: CfHeaders = {}): CfResult {
  return handler!({ request: { uri, headers } })
}
function isResponse(r: CfResult): r is CfResponse {
  return 'statusCode' in r
}
const document: CfHeaders = { 'sec-fetch-dest': { value: 'document' } }
const rscFetch: CfHeaders = { 'sec-fetch-dest': { value: 'empty' } }

describe('cdn rewrite function — RSC .txt self-heal', () => {
  it('redirects a document navigation of a route payload to its clean route', () => {
    for (const [txt, clean] of [
      ['/admin/microservices/index.txt', '/admin/microservices/'],
      ['/login/index.txt', '/login/'],
      ['/index.txt', '/'], // root sibling
    ] as const) {
      const r = run(txt, document)
      expect(isResponse(r)).toBe(true)
      if (!isResponse(r)) continue
      expect(r.statusCode).toBe(302)
      expect(r.headers.location?.value).toBe(clean)
      // The redirect itself must not be cached — it exists to break a skew.
      expect(r.headers['cache-control']?.value).toBe('no-store')
    }
  })

  it('lets the router’s own RSC fetch of a .txt payload pass straight through', () => {
    const r = run('/admin/microservices/index.txt', rscFetch)
    expect(isResponse(r)).toBe(false)
    if (isResponse(r)) return
    // Untouched: it still has a dot, so the index.html rewrite leaves it alone.
    expect(r.uri).toBe('/admin/microservices/index.txt')
  })

  it('does not redirect a .txt when Sec-Fetch-Dest is absent (never breaks a fetch)', () => {
    const r = run('/admin/users/index.txt')
    expect(isResponse(r)).toBe(false)
    if (isResponse(r)) return
    expect(r.uri).toBe('/admin/users/index.txt')
  })
})

describe('cdn rewrite function — directory index rewrite (preserved)', () => {
  it('maps directory-style routes to their static index.html', () => {
    for (const [input, expected] of [
      ['/admin/users/', '/admin/users/index.html'],
      ['/login', '/login/index.html'],
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
      '/admin/_next/static/chunks/main-app-c261856d15d797e9.js',
      '/admin/_next/static/css/a14000bdc46f5e67.css',
      '/admin/logo.svg',
    ]) {
      const r = run(asset, document)
      expect(isResponse(r)).toBe(false)
      if (isResponse(r)) continue
      expect(r.uri).toBe(asset)
    }
  })
})
