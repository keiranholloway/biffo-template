import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// The origin-response half of the API-error-body fix (biffo-template#1529).
// Unlike rewrite.js/click-rewrite.js this is Lambda@Edge source (CommonJS
// `exports.handler`, real Node.js — not the restricted CloudFront Functions
// runtime), but it's still authored as standalone JS and executed the same
// way so a change to it is caught here rather than only on a live deploy.
const repoRoot = join(__dirname, '..', '..', '..')
const source = readFileSync(
  join(repoRoot, 'modules', 'cloud', 'aws', 'cdn', 'error-status-demote.js'),
  'utf8',
)

interface CfEdgeHeaders {
  [name: string]: { key: string; value: string }[]
}
interface CfEdgeResponse {
  status: string
  statusDescription?: string
  headers: CfEdgeHeaders
}

const sandbox: {
  exports?: {
    handler?: (
      event: unknown,
      context: unknown,
      callback: (err: unknown, response: CfEdgeResponse) => void,
    ) => void
  }
} = {
  exports: {},
}
runInNewContext(source, sandbox)
const handler = sandbox.exports?.handler
if (!handler) throw new Error('error-status-demote.js did not define exports.handler')

function run(status: string, headers: CfEdgeHeaders = {}): Promise<CfEdgeResponse> {
  return new Promise((resolve, reject) => {
    const event = { Records: [{ cf: { response: { status, headers } } }] }
    handler!(event, {}, (err, response) => (err ? reject(err) : resolve(response)))
  })
}

describe('cdn API error-status demote (Lambda@Edge origin-response) — biffo-template#1529', () => {
  it('demotes a real 404 to 200 and stashes the true status in a header', async () => {
    const r = await run('404')
    expect(r.status).toBe('200')
    expect(r.headers['x-biffo-true-status']).toEqual([{ key: 'X-Biffo-True-Status', value: '404' }])
  })

  it('demotes a real 403 to 200 and stashes the true status in a header', async () => {
    const r = await run('403')
    expect(r.status).toBe('200')
    expect(r.headers['x-biffo-true-status']).toEqual([{ key: 'X-Biffo-True-Status', value: '403' }])
  })

  it('leaves every other status code untouched — only 403/404 are demoted', async () => {
    for (const status of ['200', '301', '400', '500', '502']) {
      const r = await run(status)
      expect(r.status).toBe(status)
      expect(r.headers['x-biffo-true-status']).toBeUndefined()
    }
  })

  it('never sets response.body — Lambda@Edge origin-response cannot see it, and this function must not try', () => {
    // The origin's real JSON body is never exposed to this trigger; asserting
    // the source never assigns `response.body` guards against a future edit
    // accidentally trying to synthesize one (which would silently discard
    // whatever the API actually returned).
    expect(source).not.toMatch(/response\.body\s*=/)
  })
})
