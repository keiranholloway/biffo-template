import { describe, expect, it } from 'vitest'
import type { CoreManifest } from './core-manifest.js'
import { checkCoreVersionBump } from './core-version-guard.js'

const manifest: CoreManifest = {
  version: 1,
  templateOwned: [
    'services/api/',
    'services/_plugins/',
    'cli/',
    'modules/',
    'core.version',
    'core-manifest.json',
  ],
  userOwned: ['services/', 'apps/', 'infra/'],
}

const check = (input: Partial<Parameters<typeof checkCoreVersionBump>[0]>) =>
  checkCoreVersionBump({ changedFiles: [], manifest, subjects: ['fix(cli): a change'], ...input })

describe('checkCoreVersionBump — the version is not written by hand', () => {
  /**
   * The inversion (#423). Demanding a hand bump made a conflict between
   * concurrent PRs certain: one global counter, branch protection requiring
   * up-to-date branches, so the second to merge always rebased and re-bumped.
   * The release job derives it now, so a PR that does not touch the file is
   * exactly right.
   */
  it('passes a template-owned change that does not touch core.version', () => {
    const result = check({ changedFiles: ['cli/src/index.ts'] })
    expect(result.blocked).toBe(false)
    expect(result.templateOwnedChanges).toEqual(['cli/src/index.ts'])
  })

  /**
   * The #422 hole, closed by construction rather than policed. The old guard
   * was satisfied by any CHANGE to core.version, never by it increasing — so a
   * revert restoring an already-released number passed everything. If no PR may
   * edit the file, that route does not exist.
   */
  it('refuses a hand-edit of core.version, forwards or backwards', () => {
    const result = check({ changedFiles: ['cli/src/index.ts', 'core.version'] })
    expect(result.handEdited).toBe(true)
    expect(result.blocked).toBe(true)
  })

  it('refuses a core.version edit even on its own', () => {
    expect(check({ changedFiles: ['core.version'] }).blocked).toBe(true)
  })

  it('passes when only user-owned paths changed', () => {
    const result = check({
      changedFiles: ['apps/portal/page.tsx', 'infra/environments/dev/main.tf'],
    })
    expect(result.blocked).toBe(false)
    expect(result.templateOwnedChanges).toEqual([])
  })
})

describe('checkCoreVersionBump — the subject decides the version', () => {
  /**
   * Squash-merge makes the PR title the commit subject on main, and the release
   * job reads that subject. An unclassifiable title picks the version by
   * accident, so it is refused — but only when the PR actually releases
   * something.
   */
  it('refuses an unclassifiable subject on a template-owned change', () => {
    const result = check({
      changedFiles: ['services/api/src/api/main.py'],
      subjects: ['update some stuff'],
    })
    expect(result.unclassifiableSubjects).toEqual(['update some stuff'])
    expect(result.blocked).toBe(true)
  })

  it('accepts every conventional type', () => {
    for (const type of ['feat', 'fix', 'chore', 'docs', 'test', 'infra', 'security', 'ci']) {
      const result = check({
        changedFiles: ['cli/src/index.ts'],
        subjects: [`${type}(scope): a subject`],
      })
      expect(result.blocked, type).toBe(false)
    }
  })

  it('accepts a declared breaking change', () => {
    expect(
      check({ changedFiles: ['cli/src/index.ts'], subjects: ['feat(auth)!: x'] }).blocked,
    ).toBe(false)
  })

  /**
   * A PR touching nothing template-owned releases nothing, so its subject
   * decides nothing. Complaining there would be noise on every docs-only or
   * instance-app PR.
   */
  it('ignores an unclassifiable subject when nothing template-owned changed', () => {
    const result = check({ changedFiles: ['apps/portal/page.tsx'], subjects: ['whatever'] })
    expect(result.unclassifiableSubjects).toEqual([])
    expect(result.blocked).toBe(false)
  })
})

describe('checkCoreVersionBump — instances', () => {
  it('skips entirely — a core upgrade PR rewrites template-owned paths by design', () => {
    const result = check({
      changedFiles: ['modules/cloud/aws/cdn/main.tf', 'cli/src/index.ts', 'core.version'],
      subjects: ['chore(core): upgrade template core 0.1.0 -> 0.2.0'],
      isInstance: true,
    })
    expect(result.skippedAsInstance).toBe(true)
    expect(result.blocked).toBe(false)
    // Even a core.version edit is fine there: an instance inherits the file and
    // an upgrade rewrites it. It tracks core via biffo.core.json regardless.
    expect(result.handEdited).toBe(false)
    // The paths are still reported — the guard just does not fail on them.
    expect(result.templateOwnedChanges).toEqual([
      'modules/cloud/aws/cdn/main.tf',
      'cli/src/index.ts',
    ])
  })

  it('fails closed — an omitted isInstance enforces rather than skips', () => {
    const result = checkCoreVersionBump({
      changedFiles: ['cli/src/index.ts', 'core.version'],
      manifest,
    })
    expect(result.blocked).toBe(true)
    expect(result.skippedAsInstance).toBe(false)
  })
})

describe('checkCoreVersionBump — the ownership boundary', () => {
  it('services/acme-crm is user-owned, services/api is not', () => {
    const result = check({
      changedFiles: ['services/acme-crm/biffo.plugin.json', 'services/api/src/api/main.py'],
    })
    expect(result.templateOwnedChanges).toEqual(['services/api/src/api/main.py'])
  })

  it('a first-party plugin counts; a third-party one does not', () => {
    const result = check({
      changedFiles: [
        'services/_plugins/orchestrator/src/orchestrator/actions.py',
        'services/acme-crm/src/acme/main.py',
      ],
    })
    expect(result.templateOwnedChanges).toEqual([
      'services/_plugins/orchestrator/src/orchestrator/actions.py',
    ])
  })
})
