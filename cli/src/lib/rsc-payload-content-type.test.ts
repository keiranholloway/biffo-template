import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Drift guard (issues #275, #351).
 *
 * Next's App Router emits its RSC flight payloads as `*.txt`. On static S3 +
 * CloudFront hosting they MUST be served as `text/x-component` and NOT cached
 * immutable — otherwise the client router fails to recognise the RSC response,
 * falls back to a hard navigation to the payload URL, and the browser lands on
 * raw serialised React (`/index.txt`) instead of the app.
 *
 * The fix is a three-pass `aws s3 sync`: an immutable pass that EXCLUDES `*.txt`,
 * a no-cache HTML pass, and a `text/x-component` + no-cache pass for `*.txt`.
 *
 * #275 fixed this in the core portal's `deploy-app.yml`. #351 was the same bug
 * reappearing across the portal↔sibling boundary because the fix had never been
 * ported to the sibling skeleton's `deploy.yml`. This guard binds the two
 * workflows together: any deploy workflow that ships a static Next export must
 * handle `.txt` correctly, so a fix to one that forgets the other fails CI.
 */

const repoRoot = join(__dirname, '..', '..', '..')

const read = (p: string): string => readFileSync(join(repoRoot, p), 'utf8')

// Every deploy workflow that syncs a static Next export to S3.
const staticExportDeployWorkflows = [
  '.github/workflows/deploy-app.yml',
  '_skeletons/sibling-template/.github/workflows/deploy.yml',
]

describe.each(staticExportDeployWorkflows)('RSC .txt handling in %s', (workflow) => {
  const src = read(workflow)

  it('serves *.txt as text/x-component with no-cache', () => {
    // The dedicated .txt pass: content-type override, no-cache, include *.txt.
    expect(src).toMatch(/--content-type "text\/x-component"/)
    expect(src).toMatch(/--include "\*\.txt"/)
  })

  it('excludes *.txt from every immutable pass', () => {
    // Each immutable sync pass (the only cache-control that pins for a year)
    // must exclude *.txt, or the .txt payloads get the wrong, sticky caching.
    const immutablePasses = src.match(
      /max-age=31536000, immutable[\s\S]*?(?=aws s3 sync|\n {8}\S|$)/g,
    )
    expect(immutablePasses).not.toBeNull()
    for (const pass of immutablePasses ?? []) {
      expect(pass).toMatch(/--exclude "\*\.txt"/)
    }
  })
})
