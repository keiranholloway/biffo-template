/**
 * CI entrypoint for `distribution-inventory.json`'s own schema (#1570/#1894):
 * fail when an entry is malformed, half-classified, or internally
 * inconsistent with the channel it names — `validateInventory`'s own rules
 * (a duplicate id, a "detected" row with no detector, a gap with no stated
 * reason, no evidence, no targets, a malformed `remoteContentAssertions`
 * entry...).
 *
 * Deliberately self-checkable and network-free: this only ever reads
 * `distribution-inventory.json` from THIS repo's own tree, unlike its
 * sibling `distribution-remote-state` (`check-distribution-remote-state.ts`),
 * which needs a real cross-repo `BIFFO_GITHUB_TOKEN` to fetch a NAMED REMOTE
 * repo's actual file content and is therefore wired only into the scheduled
 * `distribution-remote-state-report.yml`, never a per-PR job. Splitting the
 * two lets the schema half run bare, on every PR, with no external
 * dependency — including from `guard-denominator.test.ts`'s own sweep
 * (#1363), which runs every bare `biffo check <name>` invocation it
 * discovers and can only credit a guard that both runs AND exits 0 in an
 * environment with no cross-repo token. `distribution-remote-state` alone
 * cannot supply that (it legitimately exits 2 there — no token, cannot
 * tell), so `distribution-inventory.ts` needs a second, self-checkable path
 * to state its own denominator; this is it.
 */
import { execa } from '../lib/exec.js'
import { loadDistributionInventory, validateInventory } from '../lib/distribution-inventory.js'

export async function runDistributionInventoryCheck(root?: string): Promise<void> {
  const repoRoot = root ?? (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
  const inventory = loadDistributionInventory(repoRoot)
  const violations = validateInventory(inventory)

  console.log(
    `distribution-inventory: examined ${inventory.entries.length} inventory entr(ies) across ` +
      `${Object.keys(inventory.channels).length} declared channel(s) in distribution-inventory.json ` +
      `(${violations.length} schema violation(s))`,
  )

  if (violations.length === 0) {
    console.log('✓ distribution-inventory: every entry is well-formed and internally consistent')
    return
  }

  console.error(
    `✗ distribution-inventory: ${violations.length} schema violation(s) — an entry is malformed, ` +
      'half-classified, or inconsistent with the channel it names:\n',
  )
  for (const v of violations) {
    console.error(`  ${v.entryId} [${v.rule}]: ${v.detail}`)
  }
  process.exit(1)
}
