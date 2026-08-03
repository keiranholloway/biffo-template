import { existsSync, readFileSync } from 'node:fs'
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

  it.runIf(!runningInInstance)('does NOT ship the nav registry — it is optional', () => {
    // Reversed deliberately. As first shipped, ADR-0028 required EVERY instance
    // to carry this file, because template-owned nav.tsx imports it statically
    // and a bundler cannot degrade. `core upgrade` never carries user-owned
    // paths, so both live instances would have failed `module not found` on
    // their next upgrade. The file is now optional, defaulted by the
    // template-owned empty module and overridden by a webpack alias.
    expect(existsSync(join(repoRoot, INSTANCE_NAV_FILE))).toBe(false)
    expect(existsSync(join(repoRoot, 'apps/portal/src/lib/instance-nav-empty.ts'))).toBe(true)
  })

  it('maps @/instance-nav to exactly ONE path, which must exist', () => {
    // Next's SWC loader rejects a multi-element `paths` array for a
    // non-wildcard key outright -- "should be an array with one element because
    // the src path does not contain a wildcard" -- and the failure surfaces as
    // a Rust panic while loading next.config, which names neither this file nor
    // the seam. The tempting fallback list is what does not build.
    const tsconfig = JSON.parse(
      readFileSync(join(repoRoot, 'apps/portal/tsconfig.json'), 'utf8'),
    ) as { compilerOptions: { paths: Record<string, string[]> } }
    const mapped = tsconfig.compilerOptions.paths['@/instance-nav']
    expect(mapped, '@/instance-nav must stay mapped or nav.tsx cannot resolve').toBeDefined()
    expect(mapped).toHaveLength(1)
    expect(existsSync(join(repoRoot, 'apps/portal', mapped[0]))).toBe(true)
  })

  it('overrides that default via next.config when an instance supplies its own', () => {
    // Aliasing the '@/instance-nav' SPECIFIER silently does nothing: SWC
    // rewrites tsconfig paths at transform time, so webpack never sees the key.
    // Verified by building both ways -- the specifier alias produced a bundle
    // with the stub's contents while reporting success. The alias must target
    // the RESOLVED default path.
    //
    // Pinned to the BEHAVIOUR rather than to two variable names: this assertion
    // matched `existsSync(instanceNav)` and broke when #1098 generalised the
    // single pair into a loop over `instanceSeams`, having verified nothing
    // about whether the aliasing still worked. Two seams share the mechanism
    // now, so the invariant is that each is guarded by an existence check and
    // aliases the DEFAULT path to the instance file.
    const config = readFileSync(join(repoRoot, 'apps/portal/next.config.ts'), 'utf8')
    expect(config).toMatch(/existsSync\(/)
    expect(config).toMatch(/\[templateDefault\]: instanceFile/)
    // Both seams are declared for the alias loop to walk.
    expect(config).toMatch(/instance-nav\.ts/)
    expect(config).toMatch(/instance-nav-empty\.ts/)
  })

  it.runIf(!runningInInstance)('ships the route group with a README explaining it', () => {
    expect(existsSync(join(repoRoot, INSTANCE_ROUTE_GROUP, 'README.md'))).toBe(true)
  })
})
