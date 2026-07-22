import { describe, expect, it } from 'vitest'
import { latestCoreVersionFromTags } from './core-version.js'

/** A fake `git tag --list` returning fixed output. */
const tags =
  (...lines: string[]) =>
  () =>
    lines.join('\n')

describe('latestCoreVersionFromTags', () => {
  it('returns the highest core tag, not the lexically last', () => {
    // The bug a string sort produces: 0.9.0 > 0.58.1 alphabetically.
    expect(
      latestCoreVersionFromTags('/repo', tags('core-v0.9.0', 'core-v0.58.1', 'core-v0.10.0')),
    ).toBe('0.58.1')
  })

  it('compares numerically across all three components', () => {
    expect(latestCoreVersionFromTags('/repo', tags('core-v1.0.0', 'core-v0.58.1'))).toBe('1.0.0')
    expect(latestCoreVersionFromTags('/repo', tags('core-v0.58.2', 'core-v0.58.10'))).toBe(
      '0.58.10',
    )
  })

  it('returns null for a template with no releases yet', () => {
    expect(latestCoreVersionFromTags('/repo', tags(''))).toBeNull()
  })

  /** One stray tag must not break every upgrade in every instance. */
  it('ignores tags that are not plain semver releases', () => {
    expect(
      latestCoreVersionFromTags('/repo', tags('core-vNEXT', 'core-v0.58.1', 'core-v1.0.0-rc1')),
    ).toBe('0.58.1')
  })

  it('ignores tags that are not core tags at all', () => {
    expect(latestCoreVersionFromTags('/repo', tags('v1.2.3', 'release-2026', 'core-v0.2.0'))).toBe(
      '0.2.0',
    )
  })

  it('returns null rather than throwing when git fails', () => {
    // A non-repo, or git absent. The caller falls back; it must not crash.
    expect(
      latestCoreVersionFromTags('/repo', () => {
        throw new Error('not a git repository')
      }),
    ).toBeNull()
  })
})
