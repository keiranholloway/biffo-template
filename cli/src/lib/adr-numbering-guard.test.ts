import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ALLOWLIST_FILENAME,
  adrNumbersIn,
  findAdrNumberCollisions,
  findStaleAdrNumberingAllowlistEntries,
  formatAdrNumberCollisions,
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
