import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(__dirname, '..', '..', '..')
const cdnMainTf = join(repoRoot, 'modules', 'cloud', 'aws', 'cdn', 'main.tf')

/**
 * Parse `custom_error_response` blocks out of the CDN module, as
 * `{ error_code, response_code }` pairs.
 *
 * Deliberately reads the real file rather than a fixture: the invariant is
 * about what this distribution actually ships, and a fixture would pass while
 * the module regressed.
 */
function customErrorResponses(): { errorCode: string; responseCode: string }[] {
  const tf = readFileSync(cdnMainTf, 'utf8')
  const blocks = tf.match(/custom_error_response\s*\{[^}]*\}/g) ?? []
  return blocks.map((block) => ({
    errorCode: /error_code\s*=\s*(\d+)/.exec(block)?.[1] ?? '',
    responseCode: /response_code\s*=\s*(\d+)/.exec(block)?.[1] ?? '',
  }))
}

describe('CDN custom_error_response status passthrough (#647)', () => {
  it('finds the blocks it is asserting over', () => {
    // Guards the guard: a rename or refactor that makes the regex match nothing
    // would otherwise turn every assertion below into a vacuous pass.
    const responses = customErrorResponses()
    expect(responses.length).toBeGreaterThan(0)
    for (const r of responses) {
      expect(r.errorCode).not.toBe('')
      expect(r.responseCode).not.toBe('')
    }
  })

  it('never rewrites an error status to 200', () => {
    // The #647 defect. `custom_error_response` is distribution-wide — CloudFront
    // cannot scope it to a cache behaviour — so a 200 here makes EVERY API
    // 403/404 arrive as a successful HTML response: `res.ok` is true, no client
    // error path runs, and the failure surfaces as a JSON parse error blaming
    // the client. It also hides a broken backend behind what looks like success.
    for (const { errorCode, responseCode } of customErrorResponses()) {
      expect(
        responseCode,
        `custom_error_response for ${errorCode} rewrites the status to ${responseCode}. ` +
          `Serving the SPA shell is fine; claiming success is not (#647).`,
      ).not.toBe('200')
    }
  })

  it('preserves each error status exactly', () => {
    for (const { errorCode, responseCode } of customErrorResponses()) {
      expect(responseCode, `custom_error_response for ${errorCode}`).toBe(errorCode)
    }
  })

  it('still serves the app shell, so SPA deep links keep working', () => {
    // The fix must not become "delete the fallback": a deep link to a
    // client-routed path must still render the app. The browser renders the
    // body regardless of status, so keeping response_page_path preserves
    // routing while the status stays honest.
    const tf = readFileSync(cdnMainTf, 'utf8')
    const blocks = tf.match(/custom_error_response\s*\{[^}]*\}/g) ?? []
    for (const block of blocks) {
      expect(block).toContain('response_page_path    = "/index.html"')
    }
  })
})
