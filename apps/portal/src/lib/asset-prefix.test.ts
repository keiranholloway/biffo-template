import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SIBLINGS_MANIFEST_PATH } from './siblings-api'

/**
 * Drift guard (issue #306) — the portal must not claim the root path.
 *
 * The portal is strictly the admin console: it serves `/admin` and `/login`,
 * and `/` belongs to the user's application sibling. That is not one setting,
 * it is three files that only work together:
 *
 *   1. `next.config.ts` sets `assetPrefix: '/admin'`, so the exported HTML asks
 *      for `/admin/_next/*` instead of `/_next/*`. Without it, the root
 *      sibling — which has an empty `basePath` — publishes its assets on the
 *      identical URL prefix from a *different* S3 origin. One path, two
 *      origins; CloudFront cannot disambiguate, and whichever origin the
 *      behaviour points at answers the other app's chunk requests.
 *   2. The CDN module routes `admin`/`admin/*` and `login`/`login/*` to the
 *      portal bucket. `admin/*` is what makes (1) resolve.
 *   3. The deploy workflow moves `out/_next/` to the `admin/_next/` S3 key —
 *      `assetPrefix` rewrites URLs only, it does not move the emitted files.
 *
 * Break any one and the portal 404s its own assets, or collides with the root
 * sibling, in a way no build step catches. Hence this test.
 */

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, '../../../..')
const read = (p: string): string => readFileSync(resolve(REPO_ROOT, p), 'utf8')

describe('portal asset prefix', () => {
  it('sets assetPrefix to /admin, keeping the portal off the root asset path', () => {
    expect(read('apps/portal/next.config.ts')).toMatch(/assetPrefix:\s*'\/admin'/)
  })

  it('does not set a basePath — the admin routes are authored with their prefix', () => {
    // `basePath: '/admin'` would make src/app/admin/... serve at /admin/admin/...
    expect(read('apps/portal/next.config.ts')).not.toMatch(/^\s*basePath:/m)
  })

  it('has no app-root page, so nothing exports an index.html for /', () => {
    expect(() => read('apps/portal/src/app/page.tsx')).toThrow()
  })

  it('serves the siblings manifest from under /admin', () => {
    expect(SIBLINGS_MANIFEST_PATH.startsWith('/admin/')).toBe(true)
  })
})

describe('the routing that assetPrefix depends on', () => {
  it('the CDN routes both the bare prefix and the wildcard for admin and login', () => {
    const cdn = read('modules/cloud/aws/cdn/main.tf')
    const declared = /portal_cache_behaviors\s*=\s*\[([^\]]*)\]/.exec(cdn)?.[1] ?? ''
    const patterns = [...declared.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    // The bare pattern is not redundant: CloudFront's "admin/*" does NOT match
    // "/admin" (nothing after the slash), which is exactly how a human types it.
    expect(patterns).toEqual(['admin', 'admin/*', 'login', 'login/*'])
  })

  it('the CDN keeps no _next behaviour — that prefix is the root sibling’s', () => {
    expect(read('modules/cloud/aws/cdn/main.tf')).not.toMatch(/path_pattern\s*=\s*"_next/)
  })

  it('the deploy workflow relocates the exported assets to the admin/ S3 key', () => {
    const workflow = read('.github/workflows/deploy-app.yml')
    const moves = [...workflow.matchAll(/mv portal-dist\/_next portal-dist\/admin\/_next/g)]
    // One per environment: dev, staging, prod.
    expect(moves).toHaveLength(3)
  })
})
