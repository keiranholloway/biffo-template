import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getLatestCoreVersion, latestCoreVersionFromTags } from './core-version.js'

/**
 * Guard: the CLI must report a real version (#259).
 *
 * `cli/src/index.ts` hardcoded `.version('0.0.0')`. The publish workflow stamps
 * `package.json` from the tag being released, but a string literal in the source
 * ignores that entirely — so the first published build, `@biffo/cli@0.33.3`,
 * correctly showed 0.33.3 in the registry while `npx @biffo/cli --version`
 * printed 0.0.0.
 *
 * That defeats the reason for publishing at all: a repo scaffolded by a given
 * build could not be traced back to it, which was the third bullet of #259.
 */
const indexSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts'),
  'utf8',
)

describe('CLI version reporting', () => {
  it('does not hardcode a version literal', () => {
    // Catches `.version('0.0.0')` and any other baked-in string.
    expect(indexSrc).not.toMatch(/\.version\(\s*['"`][\d.]+['"`]\s*\)/)
  })

  it('resolves its version at runtime rather than at author time', () => {
    expect(indexSrc).toContain('getLatestCoreVersion')
  })

  /**
   * In this checkout that resolves to the highest `core-v*` tag — the version
   * the next release will be derived from (#423). Asserting the exact number
   * would just restate the tag, so assert the contract: a real semver, and the
   * same one `git tag` reports.
   */
  it('reports a real version, matching the highest core-v* tag', () => {
    const version = getLatestCoreVersion()
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(version).not.toBe('0.0.0')

    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    expect(latestCoreVersionFromTags(repoRoot)).toBe(version)
  })
})
