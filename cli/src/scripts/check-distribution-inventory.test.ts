/**
 * `biffo check distribution-inventory` (#1570/#1894): the schema-only,
 * network-free half of the distribution-inventory.json guard.
 *
 * Built to close a real CI failure, not a hypothetical: `distribution-
 * inventory.ts` is classified `isGuard: true` in `guard-candidates.ts`, but
 * its only prior CI-wired caller, `check-distribution-remote-state.ts`,
 * needs a real cross-repo `BIFFO_GITHUB_TOKEN` that a per-PR job (and
 * `guard-denominator.test.ts`'s own sweep) does not carry — so that check
 * exits 2 there, which `guard-denominator.ts` never credits (it requires
 * status 0), even though the check's own denominator line did print. This
 * script is the self-checkable path: it validates `distribution-
 * inventory.json` against its own schema — no network, no token — and
 * prints a real denominator line on every passing run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runDistributionInventoryCheck } from './check-distribution-inventory.js'
import type { DistributionInventory } from '../lib/distribution-inventory.js'
import { INSTANCE_CORE_FILE } from '../lib/core-version.js'

let exitCode: number | undefined

beforeEach(() => {
  vi.clearAllMocks()
  exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    throw new Error(`process.exit(${String(code)})`)
  }) as never)
})

function writeInventory(root: string, inventory: DistributionInventory): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'distribution-inventory.json'), JSON.stringify(inventory))
}

const CLEAN_ENTRY = {
  id: 'example-entry',
  artifact: 'AGENTS.md',
  channel: 'filesFromSkeleton' as const,
  targets: ['every sibling repo'],
  status: 'detected' as const,
  evidence: ['#1570'],
}

const CLEAN_CHANNELS = {
  filesFromSkeleton: {
    description: 'skeleton-sourced files',
    detectorCommand: 'sh scripts/shared-sync.sh --check',
    detectorImplementation: 'shared-sync.sh',
    selfCheckable: false,
    wiredIn: '.github/workflows/shared-sync-report.yml',
  },
}

describe('runDistributionInventoryCheck', () => {
  it('a schema-clean inventory prints a real denominator line and does not exit', async () => {
    const root = makeTmpDir('distribution-inventory-check-clean')
    writeInventory(root, {
      version: 1,
      note: 'test fixture',
      channels: CLEAN_CHANNELS,
      entries: [CLEAN_ENTRY],
    })

    await runDistributionInventoryCheck(root)

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    // Denominator vocabulary AND a bare count, on the line a passing run
    // always prints -- the exact shape guard-denominator.ts's
    // outputStatesADenominator requires to credit this guard.
    expect(logged).toContain('examined 1 inventory entr(ies)')
    expect(logged).toContain('0 schema violation(s)')
  })

  it('an empty inventory is a real, printed state -- zero entries still states its own count', async () => {
    const root = makeTmpDir('distribution-inventory-check-empty')
    writeInventory(root, {
      version: 1,
      note: 'test fixture',
      channels: {},
      entries: [],
    })

    await runDistributionInventoryCheck(root)

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('examined 0 inventory entr(ies)')
  })

  it('a schema violation fails loud and names the entry and rule, with no network involved', async () => {
    const root = makeTmpDir('distribution-inventory-check-violation')
    writeInventory(root, {
      version: 1,
      note: 'test fixture',
      channels: CLEAN_CHANNELS,
      entries: [
        {
          ...CLEAN_ENTRY,
          evidence: [], // triggers validateInventory's 'no-evidence' rule
        },
      ],
    })

    await expect(runDistributionInventoryCheck(root)).rejects.toThrow('process.exit(1)')

    expect(exitCode).toBe(1)
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('example-entry')
    expect(reported).toContain('no-evidence')
  })

  // #1897: `distribution-inventory.json` is a template-only registry (not
  // declared templateOwned/userOwned in core-manifest.json), but the CI step
  // that calls this function is templateOwned and lands in every instance
  // verbatim via biffo core upgrade. Before this fix, an instance -- which
  // never carries the file -- hit `loadDistributionInventory`'s throw on
  // every single PR, forever (confirmed live on tabsii-platform on core
  // 0.302.1+). These two cases are the instance-context half of that fix;
  // the three above remain the template-context half (checks run/enforce).
  it('an instance (biffo.core.json present) skips cleanly with no violation, even with no inventory file', async () => {
    const root = makeTmpDir('distribution-inventory-check-instance')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, INSTANCE_CORE_FILE), JSON.stringify({ version: '1.2.3' }))
    // Deliberately no distribution-inventory.json written -- a real instance
    // never has one; this proves the instance check fires before any attempt
    // to read the (absent) file.

    await runDistributionInventoryCheck(root)

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('skipped')
    expect(logged).toContain(INSTANCE_CORE_FILE)
  })

  it('a checkout with no biffo.core.json AND no distribution-inventory.json skips cleanly (not a template throw)', async () => {
    const root = makeTmpDir('distribution-inventory-check-neither')
    mkdirSync(root, { recursive: true })
    // Neither biffo.core.json (not an instance) nor distribution-inventory.json
    // (nothing to validate) -- e.g. a sibling/plugin repo, or any other
    // checkout that is not the template itself.

    await runDistributionInventoryCheck(root)

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('skipped')
  })

  it('an instance still skips even if it somehow also carries a distribution-inventory.json', async () => {
    // Belt-and-braces: the instance check must come first and win outright --
    // an instance is never meant to hold this registry, so its mere presence
    // (e.g. a stray leftover file) must not flip this back into validating it.
    const root = makeTmpDir('distribution-inventory-check-instance-with-file')
    writeFileSync(join(root, INSTANCE_CORE_FILE), JSON.stringify({ version: '1.2.3' }))
    writeInventory(root, {
      version: 1,
      note: 'test fixture',
      channels: CLEAN_CHANNELS,
      entries: [{ ...CLEAN_ENTRY, evidence: [] }], // would be a schema violation if validated
    })

    await runDistributionInventoryCheck(root)

    expect(process.exit).not.toHaveBeenCalled()
  })
})
