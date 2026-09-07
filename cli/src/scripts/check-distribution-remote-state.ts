/**
 * CI/schedule entrypoint for `RemoteContentAssertion`s (#1816): does the real,
 * live content of a remote repo's file still match what a
 * `distribution-inventory.json` entry's `gapReason` claims about it?
 *
 * ── The gap this closes ─────────────────────────────────────────────────
 *
 * `distribution-inventory.test.ts` already caught #1807 (a `gapReason`
 * restating a stale claim about THIS repo's own tree) with a live,
 * self-checkable assertion. #1816 was the exact same class one entry over --
 * `gitleaks-toml-plugin-repos`'s `gapReason` restated #1623's closed
 * classification of `biffo-plugin-marketing`'s `.gitleaks.toml` as current,
 * nine days after `biffo-plugin-marketing#188` made it false -- and nothing
 * caught it, because the only guard for THAT entry was a one-off regex on the
 * exact stale wording a prosecutor happened to quote, not a check against the
 * real remote file. This entrypoint is the missing caller: it walks every
 * `remoteContentAssertions` array `distribution-inventory.json` declares
 * (currently one, on `gitleaks-toml-plugin-repos`; any future entry that adds
 * one is covered by this same sweep with no new script), fetches the real,
 * live content of each named `(repo, path, ref)`, and reports a violation the
 * moment reality stops matching what an entry's assertions say it should.
 *
 * ── Why this cannot run inside `pnpm run test` ───────────────────────────
 *
 * The claims are about OTHER repos' files, and this repo's unit-test job
 * carries no cross-repo token -- the default `GITHUB_TOKEN` a CI job gets is
 * scoped to the repo that job runs in and cannot read another repo's
 * contents API. `distribution-inventory.test.ts` proves the CHECKER logic
 * offline, against real content captured once via `gh api` and committed as
 * a fixture; this file is the only thing that ever calls the real network
 * fetch, and it does so from `.github/workflows/
 * distribution-remote-state-report.yml`, scheduled, with a real
 * `BIFFO_GITHUB_TOKEN` -- the identical shape `check-instance-adoption.ts`
 * and `shared-sync.sh --check --estate` already use for "the real defect
 * lives outside this repo's own checkout".
 *
 * ── Exit codes ────────────────────────────────────────────────────────────
 *
 * 0 -- every declared assertion currently holds (or none exist -- an empty
 *     population is a real, printed state, not silently folded into "clean").
 * 1 -- at least one assertion is violated: a `gapReason` claim about a remote
 *     repo's content no longer matches reality.
 * 2 -- `gh` could not fetch one or more of the named files at all (no token,
 *     network failure, repo/path/ref no longer resolves) -- cannot tell, and
 *     never folded into a pass, the same three-valued convention every other
 *     `sh scripts/biffo.sh check *` entrypoint in this file uses.
 */
import { join } from 'node:path'
import { execa } from '../lib/exec.js'
import {
  checkRemoteContentAssertions,
  fetchRemoteContentViaGh,
  loadDistributionInventory,
  type RemoteContentAssertion,
} from '../lib/distribution-inventory.js'

async function ghExecCommand(
  file: string,
  args: string[],
): Promise<{ stdout: string; exitCode: number | null }> {
  const result = await execa(file, args, { reject: false })
  return { stdout: String(result.stdout ?? ''), exitCode: result.exitCode ?? null }
}

export async function runDistributionRemoteStateCheck(root?: string): Promise<void> {
  const repoRoot = root ?? (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
  const inventory = loadDistributionInventory(repoRoot)

  const assertions: Array<{ entryId: string; assertion: RemoteContentAssertion }> = []
  for (const entry of inventory.entries) {
    for (const assertion of entry.remoteContentAssertions ?? []) {
      assertions.push({ entryId: entry.id, assertion })
    }
  }

  console.log(
    `distribution-remote-state: examined ${assertions.length} remote content assertion(s) ` +
      `declared across ${inventory.entries.length} inventory entries ` +
      `(${join(repoRoot, 'distribution-inventory.json')})`,
  )

  if (assertions.length === 0) {
    console.log('✓ distribution-remote-state: nothing declared to check')
    return
  }

  const fetched = new Map<string, string | null>()
  let fetchFailures = 0
  for (const { assertion } of assertions) {
    const key = `${assertion.repo}\n${assertion.path}\n${assertion.ref}`
    if (fetched.has(key)) continue
    const content = await fetchRemoteContentViaGh(
      assertion.repo,
      assertion.path,
      assertion.ref,
      ghExecCommand,
    )
    fetched.set(key, content)
    if (content === null) fetchFailures += 1
  }

  if (fetchFailures > 0) {
    console.error(
      `✗ distribution-remote-state: could not fetch ${fetchFailures} of ` +
        `${fetched.size} distinct remote file(s) -- no BIFFO_GITHUB_TOKEN, network failure, ` +
        'or the file/ref no longer exists. Cannot tell whether the remaining claims hold.',
    )
    process.exit(2)
  }

  const violations = checkRemoteContentAssertions(inventory, fetched)
  if (violations.length === 0) {
    console.log(
      `✓ distribution-remote-state: all ${assertions.length} assertion(s) match real content`,
    )
    return
  }

  console.error(
    `✗ distribution-remote-state: ${violations.length} assertion(s) no longer match real ` +
      "content -- the affected entry's gapReason is stale (#1570/#1816):",
  )
  for (const v of violations) {
    console.error(`  ${v.entryId} [${v.rule}]: ${v.detail}`)
  }
  process.exit(1)
}
