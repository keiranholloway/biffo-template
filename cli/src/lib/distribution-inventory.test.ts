import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { auditClaimInvocationParity, distributedAgentsDocs } from './claim-invocation-parity.js'
import {
  deployInfraSetsTfVar,
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

  describe("gapReason claims about THIS repo's own files are checked against real state (#1807)", () => {
    it('cdn-error-status-restore-lambda-tf-var: deploy-infra.yml genuinely sets TF_VAR_error_status_demote_lambda_arn, and the gapReason does not claim otherwise', () => {
      const inv = inventory()
      const entry = inv.entries.find((e) => e.id === 'cdn-error-status-restore-lambda-tf-var')
      expect(entry, 'entry "cdn-error-status-restore-lambda-tf-var" not found').toBeTruthy()

      // Real, live check against this checkout's own workflow — #1576 wired
      // this on 2026-08-17 under the name `error_status_restore_lambda_arn`;
      // the variable itself was later renamed to `error_status_demote_lambda_arn`
      // throughout modules/cloud/aws/cdn, infra/global and this workflow — the
      // Terraform side (variables.tf, outputs.tf) had already moved, so this
      // check (and the entry's own prose below) is updated to match reality,
      // discovered 2026-08-31 when `dev`'s own CI was found red on this exact
      // mismatch. If this ever regresses, the assertion below is what should
      // fail, not a human noticing a stale gapReason months later.
      const wired = deployInfraSetsTfVar(ROOT, 'error_status_demote_lambda_arn')
      expect(
        wired,
        "TF_VAR_error_status_demote_lambda_arn is no longer set in this repo's own " +
          'deploy-infra.yml — if this genuinely regressed, update the gapReason to say so ' +
          'again (and this assertion should be flipped to document the regression)',
      ).toBe(true)

      // #1807: the entry previously claimed the opposite of what the line
      // above proves. Guard against that exact false claim reappearing.
      expect(
        entry!.gapReason,
        `"${entry!.id}"'s gapReason claims this repo's own deploy-infra.yml doesn't set the ` +
          'var, but it demonstrably does (#1807) — this is the exact stale-prose class #1570 ' +
          'was filed to surface, shipping again inside the artifact built to fix it',
      ).not.toMatch(/this repo.{0,30}deploy-infra\.yml never sets/i)
    })

    it('gitleaks-toml-plugin-repos: gapReason no longer claims biffo-plugin-marketing carries a live customised copy (#1816)', () => {
      const inv = inventory()
      const entry = inv.entries.find((e) => e.id === 'gitleaks-toml-plugin-repos')
      expect(entry, 'entry "gitleaks-toml-plugin-repos" not found').toBeTruthy()

      // #1816: biffo-plugin-marketing#188 (merged 2026-08-21, commit
      // 54aa52a9) dropped the deliberately-customised 38-line copy this
      // gapReason used to describe as current -- its dev .gitleaks.toml is
      // now the plain 4-line `useDefault = true` stub. Unlike
      // deployInfraSetsTfVar (#1807) above, that fact lives in a REMOTE
      // repo, not this checkout's own tree: this repo's CI test job carries
      // no cross-repo token (ci.yml's test step sets none; the estate's only
      // precedent for cross-repo reads, BIFFO_GITHUB_TOKEN, is wired into
      // shared-sync-report.yml, a separate scheduled workflow, not into
      // `pnpm run test`). So this cannot be a live self-checkable detector
      // call the way deployInfraSetsTfVar is -- it can only guard against
      // the exact stale claim reappearing verbatim, the same class #1570
      // exists to surface, one level less than fully closed.
      expect(
        entry!.gapReason,
        `"${entry!.id}"'s gapReason claims biffo-plugin-marketing still carries a live ` +
          'deliberately-customised copy, but biffo-plugin-marketing#188 dropped it on ' +
          '2026-08-21 -- this is the exact stale-prose class #1570 was filed to surface, ' +
          'shipping again inside the artifact built to fix it',
      ).not.toMatch(/marketing (?:additionally )?carries a deliberately-customised/i)

      // The corrected text must actually say what changed, not just avoid
      // the old wording -- otherwise this guard could pass on a DIFFERENT
      // stale claim that happens not to match the one regex above.
      expect(entry!.gapReason).toMatch(/biffo-plugin-marketing#188/)
      expect(entry!.gapReason).toMatch(/useDefault = true/)
    })
  })
})
