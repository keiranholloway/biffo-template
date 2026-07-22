import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isInstanceRepo } from './core-version.js'
import {
  UPGRADE_GUIDE_PATH,
  breakingChangesBetween,
  parseBreakingChanges,
  readBreakingChanges,
} from './breaking-changes.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const runningInInstance = isInstanceRepo(repoRoot)

const GUIDE = `# Guide

## Something else

### Not a release entry

Prose that must not be parsed as a breaking change.

## Breaking changes by version

### 0.54.0 — first-party plugin Terraform is referenced in place

Change the module source, then delete the copy.

### 0.50.0 — the email address becomes the sign-in identity

**This REPLACES the Cognito user pool and deletes every user in it.**

1. Re-invite every user.

## 1. Check where you stand

More prose.
`

describe('parseBreakingChanges', () => {
  it('reads version, title and body', () => {
    const entries = parseBreakingChanges(GUIDE)
    expect(entries.map((e) => e.version)).toEqual(['0.54.0', '0.50.0'])
    expect(entries[1]?.title).toBe('the email address becomes the sign-in identity')
    expect(entries[1]?.body).toContain('deletes every user')
    expect(entries[1]?.body).toContain('Re-invite every user')
  })

  /** `###` headings exist all over the guide. Only the ones inside the
   * breaking-changes section are release entries. */
  it('ignores subsections outside the breaking-changes section', () => {
    expect(parseBreakingChanges(GUIDE).map((e) => e.title)).not.toContain('Not a release entry')
  })

  it('stops at the next top-level heading', () => {
    expect(parseBreakingChanges(GUIDE).at(-1)?.body).not.toContain('More prose')
  })

  it('returns nothing when the section is absent', () => {
    expect(parseBreakingChanges('# Guide\n\n## Other\n\ntext\n')).toEqual([])
  })
})

describe('breakingChangesBetween', () => {
  const entries = parseBreakingChanges(GUIDE)
  const versions = (from: string, to: string) =>
    breakingChangesBetween(from, to, entries).map((e) => e.version)

  it('reports an entry the upgrade crosses', () => {
    expect(versions('0.49.2', '0.53.0')).toEqual(['0.50.0'])
  })

  it('reports several, oldest first', () => {
    expect(versions('0.49.2', '0.55.0')).toEqual(['0.50.0', '0.54.0'])
  })

  /**
   * Exclusive at the bottom: an instance already ON 0.50.0 has lived through
   * it. Warning again is noise, and noise is what makes the next warning
   * ignorable.
   */
  it('does not re-warn about the version the instance is already on', () => {
    expect(versions('0.50.0', '0.53.0')).toEqual([])
  })

  /** Inclusive at the top: an instance moving TO 0.50.0 is about to cross it. */
  it('warns when the target IS the breaking version', () => {
    expect(versions('0.49.2', '0.50.0')).toEqual(['0.50.0'])
  })

  it('reports nothing for an upgrade that crosses none', () => {
    expect(versions('0.54.0', '0.55.2')).toEqual([])
  })

  it('rejects a malformed version rather than comparing as strings', () => {
    expect(() => breakingChangesBetween('not-a-version', '0.53.0', entries)).toThrow()
  })
})

/**
 * Template-only (#367 class). `docs/` is user-owned — it is in neither
 * ownership list, so it is user-owned by fail-closed default — which means
 * `biffo core upgrade` never carries the guide. An instance keeps whatever copy
 * `biffo init` gave it, without the Breaking changes section these assertions
 * read, so they fail there on content the instance cannot receive or repair.
 *
 * That the guide does not distribute is deliberate: an instance's docs are its
 * own. The consequence is only that a template-owned test must not assert over
 * them. The warning itself is unaffected — it reads the guide from the TEMPLATE
 * at the target version, never from the instance.
 *
 * This is exactly the class #384 exists to catch automatically, and it shipped
 * anyway, hours after that issue was filed.
 */
describe.skipIf(runningInInstance)('the real upgrade guide', () => {
  /**
   * The answer to "parsing prose is brittle". A heading typo, or the section
   * being renamed, would silently disable the warning — so the parse is
   * asserted against the guide that actually ships.
   */
  it('parses the entries that really exist', () => {
    const entries = readBreakingChanges(repoRoot)
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(entry.title.length).toBeGreaterThan(10)
      // An entry with no body tells the reader nothing about what to do.
      expect(entry.body.length, `${entry.version} has no guidance`).toBeGreaterThan(80)
    }
  })

  it('still finds the Cognito entry this feature exists because of', () => {
    const entries = readBreakingChanges(repoRoot)
    const cognito = entries.find((e) => e.version === '0.50.0')
    expect(cognito, 'the 0.50.0 entry is missing from the guide').toBeTruthy()
    expect(cognito?.body).toMatch(/user pool/i)
  })

  it('every heading in the section parsed — none silently skipped', () => {
    const guide = readFileSync(join(repoRoot, UPGRADE_GUIDE_PATH), 'utf8')
    const section = guide.split('## Breaking changes by version')[1]?.split(/\n## /)[0] ?? ''
    const headings = section.match(/^### .+$/gm) ?? []
    expect(readBreakingChanges(repoRoot)).toHaveLength(headings.length)
  })
})
