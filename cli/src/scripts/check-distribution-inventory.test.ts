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
})
