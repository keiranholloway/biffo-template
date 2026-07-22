import { describe, expect, it } from 'vitest'
import type { CoreManifest } from './core-manifest.js'
import { checkReleaseSubject } from './release-subject-guard.js'

const manifest: CoreManifest = {
  version: 1,
  templateOwned: ['services/api/', 'services/_plugins/', 'cli/', 'modules/', 'core-manifest.json'],
  userOwned: ['services/', 'apps/', 'infra/'],
}

const check = (files: string[], subject: string, isInstance = false) =>
  checkReleaseSubject(files, subject, manifest, isInstance)

describe('checkReleaseSubject', () => {
  it('accepts a conventional subject on a template-owned change', () => {
    const r = check(['cli/src/index.ts'], 'feat(cli): add a flag')
    expect(r.unparseable).toBe(false)
    expect(r.bump).toBe('minor')
    expect(r.templateOwnedChanges).toEqual(['cli/src/index.ts'])
  })

  it('rejects a title the derivation cannot parse', () => {
    // The exact shape a squash-merge produces from an untidied PR title — which
    // commitlint never sees, because it lints commits and not the title.
    const r = check(['cli/src/index.ts'], 'Update the API')
    expect(r.unparseable).toBe(true)
    expect(r.bump).toBeNull()
  })

  it('rejects a bare GitHub default title', () => {
    expect(check(['services/api/src/api/main.py'], 'Merge pull request #12').unparseable).toBe(true)
  })

  it('reads the bump the release would actually take', () => {
    expect(check(['cli/x.ts'], 'fix(cli): correct it').bump).toBe('patch')
    expect(check(['cli/x.ts'], 'feat(cli): add it').bump).toBe('minor')
    // Pre-1.0, a breaking change is a minor — see release-version.ts.
    expect(check(['cli/x.ts'], 'refactor(cli)!: drop it').bump).toBe('minor')
  })

  it('does not police the title when nothing template-owned changed', () => {
    // No release is cut, so the subject is never read. Failing here would make
    // the guard fire on PRs it has no stake in.
    const r = check(['apps/portal/page.tsx', 'infra/environments/dev/main.tf'], 'whatever')
    expect(r.unparseable).toBe(false)
    expect(r.templateOwnedChanges).toEqual([])
  })

  it('skips the check in an instance, which cuts no core release', () => {
    const r = check(['cli/src/index.ts', 'services/api/src/api/main.py'], 'whatever', true)
    expect(r.skippedAsInstance).toBe(true)
    expect(r.unparseable).toBe(false)
  })

  it('still enforces in the template, where the instance marker is absent', () => {
    const r = check(['cli/src/index.ts'], 'whatever', false)
    expect(r.skippedAsInstance).toBe(false)
    expect(r.unparseable).toBe(true)
  })

  /**
   * Longest-prefix-wins ownership, asserted here because this guard and `biffo
   * core upgrade` have to agree on it: disagreement means either a release for a
   * change that never distributes, or none for a change that does.
   */
  it('honors the ownership boundary — services/acme-crm is user-owned, services/api is not', () => {
    expect(check(['services/acme-crm/handler.py'], 'whatever').templateOwnedChanges).toEqual([])
    expect(check(['services/api/src/api/main.py'], 'whatever').templateOwnedChanges).toEqual([
      'services/api/src/api/main.py',
    ])
  })

  it('treats a first-party plugin under services/_plugins/ as template-owned', () => {
    expect(check(['services/_plugins/billing/handler.py'], 'whatever').unparseable).toBe(true)
    expect(check(['services/billing/handler.py'], 'whatever').unparseable).toBe(false)
  })
})
