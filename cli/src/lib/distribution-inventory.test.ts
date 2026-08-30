import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { auditClaimInvocationParity, distributedAgentsDocs } from './claim-invocation-parity.js'
import {
  type DistributionInventory,
  loadDistributionInventory,
  validateInventory,
  wiredWorkflowPath,
  workflowInvokesCommand,
} from './distribution-inventory.js'

/**
 * The #1570 sweep: reads `distribution-inventory.json` and asserts every
 * entry is well-formed, classified, and -- wherever a real detector already
 * exists and can run from this checkout alone -- actually currently passing.
 *
 * See `distribution-inventory.ts`'s module doc comment for the two kinds of
 * "current" this file checks (a live detector call vs. a workflow-wiring
 * check), and for why an `unverified` row with a stated `gapReason` is a
 * correct, honest outcome rather than a failure to fix here.
 */

/** The repo root — the directory holding `shared-files.json` (same
 * discovery `claim-invocation-parity.test.ts` uses, kept independent of
 * `process.cwd()` so this test passes from any working directory). */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'shared-files.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`could not locate shared-files.json above ${fileURLToPath(import.meta.url)}`)
}

const ROOT = repoRoot()

function inventory(): DistributionInventory {
  return loadDistributionInventory(ROOT)
}

describe('distribution inventory (#1570): every artifact-that-must-travel is registered and classified', () => {
  it('loads distribution-inventory.json from the repo root', () => {
    const inv = inventory()
    expect(inv.entries.length).toBeGreaterThan(0)
    expect(Object.keys(inv.channels).length).toBeGreaterThan(0)
  })

  it('has no schema violations — every entry is classified, evidenced, and consistent with its channel', () => {
    const violations = validateInventory(inventory())
    if (violations.length > 0) {
      const detail = violations.map((v) => `  ${v.entryId}: [${v.rule}] ${v.detail}`).join('\n')
      throw new Error(
        `distribution-inventory.json has ${violations.length} schema violation(s):\n${detail}`,
      )
    }
  })

  it('declares no channel that no entry uses, and no entry that names an undeclared channel', () => {
    const inv = inventory()
    const declared = new Set(Object.keys(inv.channels))
    const used = new Set(inv.entries.map((e) => e.channel))

    const undeclaredUses = [...used].filter((c) => !declared.has(c))
    expect(
      undeclaredUses,
      `entries reference undeclared channel(s): ${undeclaredUses.join(', ')}`,
    ).toEqual([])

    const orphanChannels = [...declared].filter((c) => !used.has(c))
    // "none" is the deliberate catch-all for gap entries and is expected to
    // be used by at least one, asserted separately below — but every OTHER
    // declared channel must have at least one real entry, or it is dead
    // documentation nobody's row exercises.
    const unexpectedOrphans = orphanChannels.filter((c) => c !== 'none')
    expect(
      unexpectedOrphans,
      `channel(s) declared but referenced by no entry: ${unexpectedOrphans.join(', ')}`,
    ).toEqual([])
  })

  it('states plainly which rows are real gaps, and how many, split by kind', () => {
    const inv = inventory()
    const detected = inv.entries.filter((e) => e.status === 'detected')
    const unregistered = inv.entries.filter((e) => e.status === 'unregistered')
    const unverified = inv.entries.filter((e) => e.status === 'unverified')
    // Denominator first, unconditionally (#1363) — a sweep that reports
    // nothing about its own scope is indistinguishable from one that looked
    // at nothing.
    console.log(
      `distribution-inventory: ${inv.entries.length} entries — ${detected.length} detected (real ` +
        `detector reused), ${unregistered.length} unregistered (mechanism exists, artifact not ` +
        `added to it), ${unverified.length} unverified (no mechanism at all)`,
    )
    for (const g of [...unregistered, ...unverified]) {
      console.log(`  gap (${g.status}): ${g.id} — ${g.gapReason}`)
    }
    // All three buckets existing is the honest current state of the estate
    // (#1570's own comment thread: some channels are wired, one artifact's
    // mechanism exists but isn't registered, several have no channel at
    // all). A sweep that found ZERO gaps of either kind would be suspicious,
    // not reassuring — it would mean this file stopped reflecting the real
    // backlog #1570 documents.
    expect(detected.length).toBeGreaterThan(0)
    expect(unregistered.length).toBeGreaterThan(0)
    expect(unverified.length).toBeGreaterThan(0)
  })

  describe('entries whose detector is self-checkable: call the real detector, live', () => {
    it('claim-invocation entries currently pass their real detector (#1573)', () => {
      const inv = inventory()
      const selfCheckableEntries = inv.entries.filter((e) => {
        const channel = inv.channels[e.channel]
        return channel?.selfCheckable && e.status === 'detected'
      })
      expect(
        selfCheckableEntries.length,
        'expected at least one self-checkable "detected" entry (agents-md-claim-invocation-block)',
      ).toBeGreaterThan(0)

      // Reuse the REAL detector — cli/src/lib/claim-invocation-parity.ts —
      // rather than re-implementing any part of its comparison here. This is
      // the assertion that gives "current" its teeth for this channel: it
      // fails the moment the guard it wraps regresses, not merely when this
      // file's own prose goes stale.
      const docs = distributedAgentsDocs(ROOT)
      expect(docs.length, 'distributedAgentsDocs found no AGENTS.md at all').toBeGreaterThan(0)
      const violations = auditClaimInvocationParity(docs)
      expect(
        violations,
        `distribution-inventory.json claims "agents-md-claim-invocation-block" is currently ` +
          `detected/clean, but the real detector found: ${JSON.stringify(violations)}`,
      ).toEqual([])
    })
  })

  describe('entries whose detector needs an external tree: verify the channel is wired, not silently unplugged', () => {
    it('every "detected" entry on a non-self-checkable channel names a workflow that actually invokes the detector command', () => {
      const inv = inventory()
      const externalEntries = inv.entries.filter((e) => {
        const channel = inv.channels[e.channel]
        return channel && !channel.selfCheckable && e.status === 'detected'
      })
      expect(externalEntries.length).toBeGreaterThan(0)

      for (const entry of externalEntries) {
        const channel = inv.channels[entry.channel]
        const workflowPath = wiredWorkflowPath(channel.wiredIn)
        expect(
          workflowPath,
          `channel "${entry.channel}" (used by "${entry.id}") is not self-checkable and its ` +
            `wiredIn ("${channel.wiredIn}") names no .github/workflows/*.yml — a "detected" ` +
            'entry on this channel has nothing scheduled to keep it current',
        ).not.toBeNull()

        expect(
          workflowInvokesCommand(ROOT, workflowPath as string, channel.detectorCommand as string),
          `${workflowPath} no longer appears to invoke "${channel.detectorCommand}" — the ` +
            `channel backing "${entry.id}" would be scheduled but disconnected from its own detector`,
        ).toBe(true)
      }
    })
  })

  describe('gap entries are on the channel their status claims, never a live one masquerading as absent', () => {
    it('every "unverified" entry is honestly on channel "none" with no detectorCommand', () => {
      const inv = inventory()
      const gaps = inv.entries.filter((e) => e.status === 'unverified')
      expect(gaps.length).toBeGreaterThan(0)
      for (const g of gaps) {
        const channel = inv.channels[g.channel]
        expect(
          channel.detectorCommand,
          `gap entry "${g.id}" is on a channel that HAS a detector — it should be "unregistered" or "detected"`,
        ).toBeNull()
        expect(g.gapReason, `"${g.id}" has no gapReason`).toBeTruthy()
      }
    })

    it('every "unregistered" entry names a channel whose mechanism genuinely already exists', () => {
      const inv = inventory()
      const unregistered = inv.entries.filter((e) => e.status === 'unregistered')
      expect(unregistered.length).toBeGreaterThan(0)
      for (const e of unregistered) {
        const channel = inv.channels[e.channel]
        expect(
          channel.detectorCommand,
          `"unregistered" entry "${e.id}" is on channel "${e.channel}", which has no detector at all — this should be "unverified"`,
        ).not.toBeNull()
        expect(e.gapReason, `"${e.id}" has no gapReason`).toBeTruthy()
      }
    })
  })
})
