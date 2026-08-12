import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// The viewer-response half of the API-error-body fix (biffo-template#1529) is
// authored as standalone CloudFront Functions JS, same convention as
// rewrite.js and click-rewrite.js — see cdn-rewrite-function.test.ts.
const repoRoot = join(__dirname, '..', '..', '..')
const source = readFileSync(
  join(repoRoot, 'modules', 'cloud', 'aws', 'cdn', 'error-status-restore.js'),
  'utf8',
)

interface CfHeaders {
  [name: string]: { value: string }
}
interface CfResponse {
  statusCode: number
  statusDescription?: string
  headers: CfHeaders
}

const sandbox: { handler?: (event: { response: CfResponse }) => CfResponse } = {}
runInNewContext(source, sandbox)
const handler = sandbox.handler
if (!handler) throw new Error('error-status-restore.js did not define a top-level `handler`')

function run(statusCode: number, headers: CfHeaders = {}): CfResponse {
  return handler!({ response: { statusCode, headers } })
}

describe('cdn API error-status restore (viewer-response) — biffo-template#1529', () => {
  it('restores a demoted 404 back to 404 and removes the stash header', () => {
    const r = run(200, { 'x-biffo-true-status': { value: '404' } })
    expect(r.statusCode).toBe(404)
    expect(r.headers['x-biffo-true-status']).toBeUndefined()
  })

  it('restores a demoted 403 back to 403 and removes the stash header', () => {
    const r = run(200, { 'x-biffo-true-status': { value: '403' } })
    expect(r.statusCode).toBe(403)
    expect(r.headers['x-biffo-true-status']).toBeUndefined()
  })

  it('leaves an ordinary response with no stash header completely alone', () => {
    const headers = { 'content-type': { value: 'application/json' } }
    const r = run(200, headers)
    expect(r.statusCode).toBe(200)
    expect(r.headers).toEqual(headers)
  })

  it('never touches response.body — the real JSON survives untouched', () => {
    // CloudFront Functions has no access to the response body at
    // viewer-response at all; assert the source never references it, so a
    // future edit cannot introduce a body write that would silently start
    // replacing the API's real payload.
    expect(source).not.toMatch(/response\.body\s*=/)
  })

  it('never reads event.request — this behaviour is also attached to c/*, and the issue this fixes (biffo-template#1529) names a hard constraint: two different tracked-link tokens must keep producing indistinguishable 404s', () => {
    // Mirrors the identical assertion in
    // cdn-error-status-demote-function.test.ts for the other half of the
    // pair. This function only sees `event.response` in production (a
    // CloudFront Functions viewer-response event has no `request` key at
    // all), but assert the source never reaches for one anyway — a future
    // edit that tries to read the tracked-link token here to "help" would
    // silently reintroduce the exact hazard this pair was built to avoid.
    expect(source).not.toMatch(/event\.request\b/)
  })

  it('produces an identical restoration for two responses that differ only in an (irrelevant) accompanying request', () => {
    // Belt-and-braces alongside the source-shape assertion above: construct
    // the handler call with an extra `request` field present — as if a
    // future CloudFront runtime started passing one — and confirm two
    // different tracked-link tokens still produce byte-identical output.
    function runWithRequest(uri: string): CfResponse {
      return handler!({
        request: { uri, method: 'GET', headers: {} },
        response: { statusCode: 200, headers: { 'x-biffo-true-status': { value: '404' } } },
      } as unknown as { response: CfResponse })
    }
    const unknown = runWithRequest('/c/unknown-token-aaaa')
    const expired = runWithRequest('/c/expired-token-bbbb')
    expect(unknown).toEqual(expired)
  })
})
