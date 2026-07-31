import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTemplateOwned, listTemplateOwnedFiles, readCoreManifest } from './core-manifest.js'
import { isInstanceRepo } from './core-version.js'

/**
 * The ADR-0028 portal carve-out (#769).
 *
 * `apps/portal/` is a template-owned prefix that beats the user-owned `apps/`
 * on longest-match, so an instance's own admin surface had nowhere legitimate
 * to live: the only way to ship one was permanent declared divergence in files
 * the template keeps changing. Two user-owned entries fix that, resolved ahead
 * of `apps/portal/` by the same longest-prefix-wins rule that already gives
 * `services/api/src/api/domains/` (ADR-0022) precedence over `services/api/`.
 *
 * This asserts against the REAL manifest and the REAL resolver, including
 * template-owned controls — an ownership test that only ever says "not owned"
 * would still pass if the whole portal fell out of the manifest.
 */
const repoRoot = join(__dirname, '..', '..', '..')

const INSTANCE_ROUTE_GROUP = 'apps/portal/src/app/admin/(instance)/'
const INSTANCE_NAV_FILE = 'apps/portal/src/instance-nav.ts'

describe('portal instance carve-out is user-owned (ADR-0028)', () => {
  const manifest = readCoreManifest(repoRoot)

  const userOwnedPaths = [
    // The seed itself.
    `${INSTANCE_ROUTE_GROUP}README.md`,
    // A route inside the group, and anything co-located with it.
    `${INSTANCE_ROUTE_GROUP}demo-requests/page.tsx`,
    `${INSTANCE_ROUTE_GROUP}demo-requests/page.test.tsx`,
    `${INSTANCE_ROUTE_GROUP}lib/demo-request-admin-api.ts`,
    // Discovery: the nav registry is an exact-file carve-out.
    INSTANCE_NAV_FILE,
  ]

  it.each(userOwnedPaths)('%s is NOT template-owned', (path) => {
    expect(isTemplateOwned(path, manifest)).toBe(false)
  })

  const templateOwnedPaths = [
    // Control: the rest of the portal is still the template's.
    'apps/portal/src/components/nav.tsx',
    'apps/portal/src/app/admin/users/page.tsx',
    'apps/portal/src/app/admin/layout.tsx',
    // The contract half of the seam stays template-owned, so the template can
    // evolve the shape while the instance owns only the data.
    'apps/portal/src/lib/instance-nav-contract.ts',
  ]

  it.each(templateOwnedPaths)('%s IS template-owned', (path) => {
    expect(isTemplateOwned(path, manifest)).toBe(true)
  })

  it('the carve-out beats apps/portal/ only for the exact nav file, not its neighbours', () => {
    // `instance-nav.ts` is an exact-file entry; a sibling with a similar name
    // must not be dragged out of template ownership by a sloppy prefix match.
    expect(isTemplateOwned('apps/portal/src/instance-nav-extras.ts', manifest)).toBe(true)
    expect(isTemplateOwned('apps/portal/src/instance-nav.ts', manifest)).toBe(false)
  })

  it('biffo core upgrade carries neither path', () => {
    const carried = listTemplateOwnedFiles(repoRoot, manifest, { trackedOnly: true })
    // Sanity: the listing must actually see the portal, or the exclusions below
    // would pass vacuously.
    expect(carried).toContain('apps/portal/src/components/nav.tsx')
    expect(carried).toContain('apps/portal/src/lib/instance-nav-contract.ts')

    expect(carried).not.toContain(INSTANCE_NAV_FILE)
    expect(carried.filter((p) => p.startsWith(INSTANCE_ROUTE_GROUP))).toEqual([])
  })
})

describe('the template seeds the carve-out', () => {
  // Only meaningful in the template. An instance owns both paths and may
  // legitimately rename, replace, or delete the seeded README.
  const runningInInstance = isInstanceRepo(repoRoot)

  it.runIf(!runningInInstance)('ships an empty nav registry for an instance to append to', () => {
    expect(existsSync(join(repoRoot, INSTANCE_NAV_FILE))).toBe(true)
  })

  it.runIf(!runningInInstance)('ships the route group with a README explaining it', () => {
    expect(existsSync(join(repoRoot, INSTANCE_ROUTE_GROUP, 'README.md'))).toBe(true)
  })
})
