import { describe, expect, it } from 'vitest'
import { decideRelease } from './release-version.js'

const state = (over: Partial<Parameters<typeof decideRelease>[0]> = {}) =>
  decideRelease({
    latestVersion: '0.59.2',
    latestTagIsHead: false,
    templateTreeChanged: true,
    subject: 'fix(cli): a change',
    ...over,
  })

describe('decideRelease', () => {
  it('releases the next patch for a template-owned fix', () => {
    expect(state()).toEqual({ kind: 'release', version: '0.59.3' })
  })

  it('releases a minor for a feat', () => {
    expect(state({ subject: 'feat(api): a capability' })).toEqual({
      kind: 'release',
      version: '0.60.0',
    })
  })

  /**
   * Most commits on main are user-owned and reach no instance. Releasing one
   * would mint a version whose tag has a tree identical to the previous — every
   * instance offered an upgrade containing nothing.
   */
  it('releases nothing when no template-owned path changed', () => {
    expect(state({ templateTreeChanged: false })).toEqual({ kind: 'nothing-to-release' })
  })

  it('is idempotent — a re-run on an already-released HEAD does nothing', () => {
    expect(state({ latestTagIsHead: true })).toEqual({
      kind: 'already-released',
      version: '0.59.2',
    })
  })

  /**
   * The property that retires the #294/#342 state machine: the version is
   * always higher than every tag that exists, so the tag it names cannot
   * already exist, so nothing can ever be asked to move a published tag.
   */
  it('always names a version above the highest existing tag', () => {
    for (const subject of ['fix: x', 'feat: x', 'chore: x', 'feat!: x', 'unparseable']) {
      const decision = state({ subject })
      expect(decision.kind).toBe('release')
      if (decision.kind === 'release') {
        expect(decision.version > '0.59.2' || decision.version === '0.60.0').toBe(true)
      }
    }
  })

  /** A fresh template releases its first version without a seed tag by hand. */
  it('releases a first version when there are no tags at all', () => {
    expect(state({ latestVersion: null })).toEqual({ kind: 'release', version: '0.0.1' })
    expect(state({ latestVersion: null, subject: 'feat: first' })).toEqual({
      kind: 'release',
      version: '0.1.0',
    })
  })

  it('a fresh template releases even though nothing "changed"', () => {
    // With no previous tag there is nothing to diff against, so the
    // template-tree check must not suppress the first release.
    expect(state({ latestVersion: null, templateTreeChanged: false }).kind).toBe('release')
  })
})
