import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { auditClaimInvocationParity, distributedAgentsDocs } from './claim-invocation-parity.js'
import {
  checkRemoteContentAssertions,
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

      // The corrected text must actually say what changed -- cheap to check
      // and still useful as documentation -- but the REAL guard against this
      // recurring is the content-based sweep below, not this wording check:
      // a regex on prose only ever catches the one sentence a prosecutor
      // happened to quote (see the #1816 class discussion in the describe()
      // block below).
      expect(entry!.gapReason).toMatch(/biffo-plugin-marketing#188/)
      expect(entry!.gapReason).toMatch(/useDefault = true/)
    })
  })

  describe("gapReason claims about a REMOTE repo's content are checked against real, captured content, generically (#1816)", () => {
    // Real content captured live via the exact commands #1816's own report
    // used (re-run 2026-08-31 for this test):
    //
    //   gh api "repos/keiranholloway/biffo-plugin-marketing/contents/.gitleaks.toml?ref=54aa52a9~1" --jq '.content' | base64 -d
    //   gh api "repos/keiranholloway/biffo-plugin-marketing/contents/.gitleaks.toml?ref=dev" --jq '.content' | base64 -d
    //
    // The first is the pre-#188 commit (the "deliberately-customised 38-line
    // copy" the stale gapReason described); the second is the real current
    // dev tip. Both are the actual file bytes, not a hand-written stand-in --
    // the same discipline #1628's case-matrix work established for "a case
    // labelled captured live must actually have been captured live".
    const OLD_CONTENT_PRE_1816 = `title = "Biffo Plugin Gitleaks Configuration"

# Mirrors biffo-template's .gitleaks.toml \`biffo-aws-account-id\` rule
# verbatim (see /home/keiran/code/biffo-template/.gitleaks.toml). Without it,
# a bare 12-digit fixture value passes this repo's own Secret Scan and only
# fails one repo and one CI cycle downstream, once vendored into an instance
# whose gitleaks config does have this rule (#19). A plugin repo's gates
# should be a superset of what its vendored copy will face downstream.

[extend]
useDefault = true

[[rules]]
id = "biffo-aws-account-id"
description = "AWS Account ID — should only appear in .tfvars.example or biffo.config.json placeholders"
regex = '''\\b\\d{12}\\b'''
entropy = 0
[rules.allowlist]
regexes = [
  "\\\\{\\\\{AWS_ACCOUNT_ID\\\\}\\\\}",  # placeholder in template files
  "123456789012",                  # canonical example account ID used in tests
  "999999999999",                  # canonical wrong-account ID used in error-path tests
]
commits = [
  "bfb5dc5e075cc740dfaed146aa53aa1fca4dab45",
  "86f57b34c7ada4b7f84276148722602b29e8e57b",
  "d2ddeef824268a5ec6464f5019b71735fd6d249c",
]
`

    const NEW_CONTENT_LIVE_DEV = `title = "Biffo Plugin Gitleaks Configuration"

[extend]
useDefault = true
`

    it('would have flagged the PRE-#188 content as a violation (fail-first: proves this catches the #1816 shape)', () => {
      const inv = inventory()
      const entry = inv.entries.find((e) => e.id === 'gitleaks-toml-plugin-repos')
      expect(
        entry!.remoteContentAssertions?.length,
        'no remoteContentAssertions declared',
      ).toBeGreaterThan(0)
      const assertion = entry!.remoteContentAssertions![0]

      const fetched = new Map<string, string | null>([
        [`${assertion.repo}\n${assertion.path}\n${assertion.ref}`, OLD_CONTENT_PRE_1816],
      ])
      const violations = checkRemoteContentAssertions(inv, fetched)
      expect(
        violations,
        'checking the PRE-#188 content should have failed -- it is exactly the customised copy ' +
          'the stale gapReason described as current, and this is the fixture proving the ' +
          'checker would actually have caught #1816 before a prosecutor had to find it by hand',
      ).not.toEqual([])
      expect(violations.some((v) => v.rule === 'contains-forbidden-substring')).toBe(true)
    })

    it('passes clean against the REAL current dev content', () => {
      const inv = inventory()
      const entry = inv.entries.find((e) => e.id === 'gitleaks-toml-plugin-repos')
      const assertion = entry!.remoteContentAssertions![0]

      const fetched = new Map<string, string | null>([
        [`${assertion.repo}\n${assertion.path}\n${assertion.ref}`, NEW_CONTENT_LIVE_DEV],
      ])
      const violations = checkRemoteContentAssertions(inv, fetched)
      expect(
        violations,
        `entry's remoteContentAssertions do not match the real current biffo-plugin-marketing ` +
          `dev .gitleaks.toml: ${JSON.stringify(violations)}`,
      ).toEqual([])
    })

    it('is generic across every entry that declares remoteContentAssertions, not hardcoded to one id', () => {
      // Synthetic inventory, independent of the real distribution-inventory.json,
      // proving the sweep function itself has no special-cased id anywhere --
      // it walks whatever entries + assertions it is given. This is the
      // structural answer to #1816's own CAUSE finding: "checked against
      // reality nowhere except that one narrow per-entry regex" -- the new
      // mechanism is entry-agnostic by construction, so a THIRD entry that
      // adds remoteContentAssertions is covered with zero new test code.
      const synthetic: DistributionInventory = {
        version: 1,
        note: 'synthetic, test-only',
        channels: { none: inventory().channels.none },
        entries: [
          {
            id: 'synthetic-entry-a',
            artifact: 'a',
            channel: 'none',
            targets: ['some-other-repo'],
            status: 'unverified',
            gapReason: 'synthetic',
            evidence: ['n/a'],
            remoteContentAssertions: [
              { repo: 'org/repo-a', path: 'FILE_A', ref: 'dev', mustContain: ['present'] },
            ],
          },
          {
            id: 'synthetic-entry-b',
            artifact: 'b',
            channel: 'none',
            targets: ['yet-another-repo'],
            status: 'unverified',
            gapReason: 'synthetic',
            evidence: ['n/a'],
            remoteContentAssertions: [
              { repo: 'org/repo-b', path: 'FILE_B', ref: 'dev', mustNotContain: ['forbidden'] },
            ],
          },
        ],
      }

      const cleanFetch = new Map<string, string | null>([
        ['org/repo-a\nFILE_A\ndev', 'this file has present in it'],
        ['org/repo-b\nFILE_B\ndev', 'this file has neither word'],
      ])
      expect(checkRemoteContentAssertions(synthetic, cleanFetch)).toEqual([])

      const dirtyFetch = new Map<string, string | null>([
        ['org/repo-a\nFILE_A\ndev', 'missing the required word entirely'],
        ['org/repo-b\nFILE_B\ndev', 'this file has forbidden in it'],
      ])
      const violations = checkRemoteContentAssertions(synthetic, dirtyFetch)
      expect(violations.map((v) => v.entryId).sort()).toEqual([
        'synthetic-entry-a',
        'synthetic-entry-b',
      ])
      expect(violations.find((v) => v.entryId === 'synthetic-entry-a')?.rule).toBe(
        'missing-required-substring',
      )
      expect(violations.find((v) => v.entryId === 'synthetic-entry-b')?.rule).toBe(
        'contains-forbidden-substring',
      )
    })

    it('reports fetch-failed rather than silently passing when content could not be fetched', () => {
      const inv = inventory()
      const entry = inv.entries.find((e) => e.id === 'gitleaks-toml-plugin-repos')
      const assertion = entry!.remoteContentAssertions![0]

      // A missing map entry (never fetched) and an explicit null (fetch
      // attempted and failed) must BOTH be treated as cannot-tell, never as
      // a clean pass -- the same "2 is never folded into a pass" convention
      // every other check in this repo uses.
      const violationsMissing = checkRemoteContentAssertions(inv, new Map())
      expect(violationsMissing.some((v) => v.rule === 'fetch-failed')).toBe(true)

      const violationsNull = checkRemoteContentAssertions(
        inv,
        new Map([[`${assertion.repo}\n${assertion.path}\n${assertion.ref}`, null]]),
      )
      expect(violationsNull.some((v) => v.rule === 'fetch-failed')).toBe(true)
    })
  })
})
