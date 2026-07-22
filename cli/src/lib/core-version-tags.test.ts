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

describe('latestCoreVersionFromTags — fetching', () => {
  /**
   * The regression this exists for. Tags do not arrive with `git pull`: the
   * release job creates core-v<version> AFTER the merge, so a checkout freshly
   * pulled on main still lacks the newest tag. Reading local tags alone
   * resolved one version behind and offered two instances 0.58.1 when 0.59.0
   * was released.
   */
  it('fetches tags before listing them', () => {
    const calls: string[][] = []
    latestCoreVersionFromTags('/repo', (args) => {
      calls.push(args)
      return args.includes('--list') ? 'core-v0.59.0' : ''
    })
    expect(calls[0]).toEqual(['-C', '/repo', 'fetch', '--tags', '--quiet'])
    expect(calls[1]).toContain('--list')
  })

  it('still resolves when the fetch fails — offline, or no remote', () => {
    const version = latestCoreVersionFromTags('/repo', (args) => {
      if (args.includes('fetch')) throw new Error('no remote')
      return 'core-v0.58.1'
    })
    expect(version).toBe('0.58.1')
  })

  it('picks up a tag that only the fetch made visible', () => {
    let fetched = false
    const version = latestCoreVersionFromTags('/repo', (args) => {
      if (args.includes('fetch')) {
        fetched = true
        return ''
      }
      return fetched ? 'core-v0.58.1\ncore-v0.59.0' : 'core-v0.58.1'
    })
    expect(version).toBe('0.59.0')
  })
})
