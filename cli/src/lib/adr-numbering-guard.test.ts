import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ALLOWLIST_FILENAME,
  TEMPLATE_ADR_RESERVED_UPTO,
  adrNumbersIn,
  findAdrNumberCollisions,
  findAdrReservedRangeViolations,
  findStaleAdrNumberingAllowlistEntries,
  formatAdrNumberCollisions,
  formatAdrReservedRangeViolations,
  readAdrNumberingAllowlist,
} from './adr-numbering-guard.js'

let adrDir: string

beforeEach(() => {
  adrDir = mkdtempSync(join(tmpdir(), 'adr-numbering-'))
})

afterEach(() => {
  rmSync(adrDir, { recursive: true, force: true })
})

function file(name: string): void {
  writeFileSync(join(adrDir, name), '')
}

describe('adrNumbersIn', () => {
  it('maps each numeric prefix to its file', () => {
    file('0001-single-tenant-architecture.md')
    file('0002-api-only-data-integration.md')
    expect(adrNumbersIn(adrDir)).toEqual(
      new Map([
        ['0001', ['0001-single-tenant-architecture.md']],
        ['0002', ['0002-api-only-data-integration.md']],
      ]),
    )
  })

  it('collects more than one file under the same number', () => {
    file('0010-database-enforced-rbac-with-rls.md')
    file('0010-event-registry-and-trigger-consolidation.md')
    expect(adrNumbersIn(adrDir).get('0010')).toEqual([
      '0010-database-enforced-rbac-with-rls.md',
      '0010-event-registry-and-trigger-consolidation.md',
    ])
  })

  it('ignores files that do not match the numbering convention', () => {
    file('README.md')
    file('template.md')
    expect(adrNumbersIn(adrDir).size).toBe(0)
  })

  it('returns an empty map for a directory that does not exist', () => {
    expect(adrNumbersIn(join(adrDir, 'does-not-exist'))).toEqual(new Map())
  })
})

describe('findAdrNumberCollisions', () => {
  it('reports nothing when every number is unique', () => {
    file('0001-single-tenant-architecture.md')
    file('0002-api-only-data-integration.md')
    expect(findAdrNumberCollisions(adrDir)).toEqual([])
  })

  it('reports a number claimed by two files, sorted', () => {
    file('0010-event-registry-and-trigger-consolidation.md')
    file('0010-database-enforced-rbac-with-rls.md')
    expect(findAdrNumberCollisions(adrDir)).toEqual([
      {
        number: '0010',
        files: [
          '0010-database-enforced-rbac-with-rls.md',
          '0010-event-registry-and-trigger-consolidation.md',
        ],
      },
    ])
  })

  it('reports every colliding number when there is more than one', () => {
    file('0009-brand-scoped-authorization.md')
    file('0009-internal-service-authentication.md')
    file('0010-database-enforced-rbac-with-rls.md')
    file('0010-event-registry-and-trigger-consolidation.md')
    file('0011-authorization-is-a-core-concern.md')
    const collisions = findAdrNumberCollisions(adrDir)
    expect(collisions.map((c) => c.number)).toEqual(['0009', '0010'])
  })

  it('does not flag a number a single file claims', () => {
    file('0100-unified-login-and-role-based-landing.md')
    expect(findAdrNumberCollisions(adrDir)).toEqual([])
  })

  it('does not flag a collision the allowlist names', () => {
    file('0009-brand-scoped-authorization.md')
    file('0009-internal-service-authentication.md')
    file('0010-database-enforced-rbac-with-rls.md')
    file('0010-event-registry-and-trigger-consolidation.md')
    writeFileSync(join(adrDir, ALLOWLIST_FILENAME), '0009\n0010\n')
    expect(findAdrNumberCollisions(adrDir)).toEqual([])
  })

  it('still flags a collision the allowlist does not mention', () => {
    file('0009-brand-scoped-authorization.md')
    file('0009-internal-service-authentication.md')
    file('0010-database-enforced-rbac-with-rls.md')
    file('0010-event-registry-and-trigger-consolidation.md')
    writeFileSync(join(adrDir, ALLOWLIST_FILENAME), '0009\n')
    expect(findAdrNumberCollisions(adrDir).map((c) => c.number)).toEqual(['0010'])
  })
})

describe('findAdrReservedRangeViolations (#1105)', () => {
  it('flags a new instance ADR numbered inside the reserved range', () => {
    file('0012-identity-provider-seam.md')
    expect(findAdrReservedRangeViolations(adrDir)).toEqual([
      { number: '0012', file: '0012-identity-provider-seam.md' },
    ])
  })

  it('does not flag a file numbered above the reserved range', () => {
    file('0100-unified-login-and-role-based-landing.md')
    expect(findAdrReservedRangeViolations(adrDir)).toEqual([])
  })

  it('does not flag a file the allowlist accepts', () => {
    file('0012-identity-provider-seam.md')
    writeFileSync(join(adrDir, ALLOWLIST_FILENAME), '0012\n')
    expect(findAdrReservedRangeViolations(adrDir)).toEqual([])
  })

  it('flags every file at a violating number, not just one', () => {
    file('0012-identity-provider-seam.md')
    // Same number claimed twice — a collision AND a reserved-range violation
    // are independent findings; this check reports both files regardless.
    file('0012-something-else.md')
    expect(
      findAdrReservedRangeViolations(adrDir)
        .map((v) => v.file)
        .sort(),
    ).toEqual(['0012-identity-provider-seam.md', '0012-something-else.md'])
  })

  it('respects a custom boundary', () => {
    file('0050-something.md')
    // 0050 is outside a 0028 boundary — not reserved, not flagged.
    expect(findAdrReservedRangeViolations(adrDir, '0028')).toEqual([])
    // 0050 is inside a 0055 or 0099 boundary — reserved, flagged.
    expect(findAdrReservedRangeViolations(adrDir, '0055')).toEqual([
      { number: '0050', file: '0050-something.md' },
    ])
    expect(findAdrReservedRangeViolations(adrDir, '0099')).toEqual([
      { number: '0050', file: '0050-something.md' },
    ])
  })

  it('the default boundary is TEMPLATE_ADR_RESERVED_UPTO', () => {
    file(`${TEMPLATE_ADR_RESERVED_UPTO}-at-the-boundary.md`)
    expect(findAdrReservedRangeViolations(adrDir)).toEqual([
      {
        number: TEMPLATE_ADR_RESERVED_UPTO,
        file: `${TEMPLATE_ADR_RESERVED_UPTO}-at-the-boundary.md`,
      },
    ])
  })
})

describe('readAdrNumberingAllowlist', () => {
  it('returns an empty set when the file does not exist', () => {
    expect(readAdrNumberingAllowlist(adrDir)).toEqual(new Set())
  })

  it('parses one number per line', () => {
    writeFileSync(join(adrDir, ALLOWLIST_FILENAME), '0009\n0010\n')
    expect(readAdrNumberingAllowlist(adrDir)).toEqual(new Set(['0009', '0010']))
  })

  it('ignores blank lines and # comments, including trailing ones', () => {
    writeFileSync(
      join(adrDir, ALLOWLIST_FILENAME),
      '# tabsii-platform#449 — ~45 code call-sites, not worth renumbering\n' +
        '0009  # brand-scoped-authorization vs internal-service-authentication\n' +
        '\n' +
        '0010\n',
    )
    expect(readAdrNumberingAllowlist(adrDir)).toEqual(new Set(['0009', '0010']))
  })
})

describe('findStaleAdrNumberingAllowlistEntries', () => {
  it('reports nothing when every allowlisted number still collides', () => {
    file('0009-brand-scoped-authorization.md')
    file('0009-internal-service-authentication.md')
    writeFileSync(join(adrDir, ALLOWLIST_FILENAME), '0009\n')
    expect(findStaleAdrNumberingAllowlistEntries(adrDir)).toEqual([])
  })

  it('reports a number that stopped colliding', () => {
    file('0009-brand-scoped-authorization.md') // the other 0009 was renumbered away
    writeFileSync(join(adrDir, ALLOWLIST_FILENAME), '0009\n')
    expect(findStaleAdrNumberingAllowlistEntries(adrDir)).toEqual(['0009'])
  })

  it('reports a number allowlisted but never present at all', () => {
    writeFileSync(join(adrDir, ALLOWLIST_FILENAME), '0009\n')
    expect(findStaleAdrNumberingAllowlistEntries(adrDir)).toEqual(['0009'])
  })

  it('does not flag a non-colliding entry still needed for the reserved range, in an instance', () => {
    file('0012-identity-provider-seam.md')
    writeFileSync(join(adrDir, ALLOWLIST_FILENAME), '0012\n')
    expect(
      findStaleAdrNumberingAllowlistEntries(adrDir, {
        isInstance: true,
        reservedUpTo: TEMPLATE_ADR_RESERVED_UPTO,
      }),
    ).toEqual([])
  })

  it('flags a reserved-range entry once the file is gone, in an instance', () => {
    // No file claims 0012 any more — the entry outlived its reason.
    writeFileSync(join(adrDir, ALLOWLIST_FILENAME), '0012\n')
    expect(
      findStaleAdrNumberingAllowlistEntries(adrDir, {
        isInstance: true,
        reservedUpTo: TEMPLATE_ADR_RESERVED_UPTO,
      }),
    ).toEqual(['0012'])
  })

  it('ignores the reserved range in the template (isInstance omitted / false)', () => {
    // Same fixture as the "does not flag" case above, but without isInstance:
    // a single claimant with no collision is reported stale, because the
    // template's own ADRs are never checked against the reserved range.
    file('0012-identity-provider-seam.md')
    writeFileSync(join(adrDir, ALLOWLIST_FILENAME), '0012\n')
    expect(findStaleAdrNumberingAllowlistEntries(adrDir)).toEqual(['0012'])
  })

  it('an entry needed for a collision stays even if it would also be reserved-range-stale', () => {
    file('0012-identity-provider-seam.md')
    file('0012-something-else.md')
    writeFileSync(join(adrDir, ALLOWLIST_FILENAME), '0012\n')
    expect(findStaleAdrNumberingAllowlistEntries(adrDir, { isInstance: true })).toEqual([])
  })
})

describe('formatAdrNumberCollisions', () => {
  it('names the colliding files and the ambiguity they cause', () => {
    const report = formatAdrNumberCollisions([
      { number: '0010', files: ['0010-a.md', '0010-b.md'] },
    ])
    expect(report).toContain('ADR-0010')
    expect(report).toContain('0010-a.md')
    expect(report).toContain('0010-b.md')
    expect(report).toContain('ambiguous')
  })
})

describe('formatAdrReservedRangeViolations', () => {
  it('names the file, the number, and both remedies', () => {
    const report = formatAdrReservedRangeViolations([
      { number: '0012', file: '0012-identity-provider-seam.md' },
    ])
    expect(report).toContain('0012-identity-provider-seam.md')
    expect(report).toContain('ADR-0012')
    expect(report).toContain('Renumber it above ADR-0099')
    expect(report).toContain(ALLOWLIST_FILENAME)
  })
})

describe('#1096: this guard only ever reaches the docs/ADR/ directory it is given', () => {
  // The ownership-boundary question #1096 raised is whether a template-owned
  // check (this file, distributed via `biffo core upgrade`) can assert over
  // content outside its declared subject. These functions take `adrDir` as a
  // parameter and never derive a path of their own — proving that means
  // proving a SIBLING directory's content (which would model, e.g., a
  // different repo's docs/ADR/, or template-owned content elsewhere in the
  // same repo) is never read, collided against, or reported, no matter what
  // it contains.
  it('adrNumbersIn/findAdrNumberCollisions/findAdrReservedRangeViolations ignore a sibling directory entirely', () => {
    const parent = mkdtempSync(join(tmpdir(), 'adr-numbering-scope-'))
    const ownDir = join(parent, 'docs', 'ADR')
    const siblingDir = join(parent, 'elsewhere')
    mkdirSync(dirname(ownDir), { recursive: true })
    mkdirSync(ownDir)
    mkdirSync(siblingDir)
    try {
      // The sibling directory alone would collide with, and violate, every
      // check this file offers, if the scan escaped `ownDir`.
      writeFileSync(join(siblingDir, '0012-identity-provider-seam.md'), '')
      writeFileSync(join(siblingDir, '0012-something-else.md'), '')
      writeFileSync(join(siblingDir, ALLOWLIST_FILENAME), 'not-a-real-allowlist')

      expect(adrNumbersIn(ownDir)).toEqual(new Map())
      expect(findAdrNumberCollisions(ownDir)).toEqual([])
      expect(findAdrReservedRangeViolations(ownDir)).toEqual([])
      expect(findStaleAdrNumberingAllowlistEntries(ownDir, { isInstance: true })).toEqual([])
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
