import { describe, expect, it } from 'vitest'
import type { CoreManifest } from './core-manifest.js'
import { checkCoreVersionBump } from './core-version-guard.js'

const manifest: CoreManifest = {
  version: 1,
  templateOwned: ['services/api/', 'cli/', 'modules/', 'core.version', 'core-manifest.json'],
  userOwned: ['services/', 'apps/', 'infra/'],
}

describe('checkCoreVersionBump', () => {
  it('requires a bump when a template-owned path changed without one', () => {
    const result = checkCoreVersionBump(
      ['cli/src/index.ts', 'apps/portal/page.tsx'],
      false,
      manifest,
    )
    expect(result.bumpRequired).toBe(true)
    expect(result.templateOwnedChanges).toEqual(['cli/src/index.ts'])
  })

  it('passes when the bump is present', () => {
    const result = checkCoreVersionBump(['cli/src/index.ts'], true, manifest)
    expect(result.bumpRequired).toBe(false)
    expect(result.templateOwnedChanges).toEqual(['cli/src/index.ts'])
  })

  it('passes when only user-owned paths changed', () => {
    const result = checkCoreVersionBump(
      ['apps/portal/page.tsx', 'infra/environments/dev/main.tf'],
      false,
      manifest,
    )
    expect(result.bumpRequired).toBe(false)
    expect(result.templateOwnedChanges).toEqual([])
  })

  it('does not count core.version itself as a template-owned change needing a bump', () => {
    const result = checkCoreVersionBump(['core.version'], true, manifest)
    expect(result.bumpRequired).toBe(false)
    expect(result.templateOwnedChanges).toEqual([])
  })

  it('skips the check in an instance — a core upgrade PR rewrites template-owned paths by design', () => {
    const result = checkCoreVersionBump(
      ['modules/cloud/aws/cdn/main.tf', 'cli/src/index.ts', 'biffo.core.json'],
      false,
      manifest,
      true,
    )
    expect(result.bumpRequired).toBe(false)
    expect(result.skippedAsInstance).toBe(true)
    // The paths are still reported — the guard just doesn't fail on them.
    expect(result.templateOwnedChanges).toEqual([
      'modules/cloud/aws/cdn/main.tf',
      'cli/src/index.ts',
    ])
  })

  it('still enforces in the template, where the instance marker is absent', () => {
    const result = checkCoreVersionBump(['modules/cloud/aws/cdn/main.tf'], false, manifest, false)
    expect(result.bumpRequired).toBe(true)
    expect(result.skippedAsInstance).toBe(false)
  })

  it('fails closed — an omitted isInstance enforces rather than skips', () => {
    const result = checkCoreVersionBump(['cli/src/index.ts'], false, manifest)
    expect(result.bumpRequired).toBe(true)
    expect(result.skippedAsInstance).toBe(false)
  })

  it('honors the ownership boundary — services/rbac is user-owned, services/api is not', () => {
    const result = checkCoreVersionBump(
      ['services/rbac/biffo.plugin.json', 'services/api/src/api/main.py'],
      false,
      manifest,
    )
    expect(result.bumpRequired).toBe(true)
    expect(result.templateOwnedChanges).toEqual(['services/api/src/api/main.py'])
  })
})
