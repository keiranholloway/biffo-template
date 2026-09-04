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
 *
 * ## Instance skip (#1897)
 *
 * `distribution-inventory.json` is a template-only registry of the channels
 * biffo-template ITSELF uses to distribute to other repos. It is not
 * declared `templateOwned` or `userOwned` in `core-manifest.json`, so
 * `biffo core upgrade` never carries it and no instance is meant to hold
 * one — but `.github/workflows/ci.yml`'s "Distribution-inventory schema
 * guard" step (and `scripts/verify.sh`'s equivalent local gate) IS
 * `templateOwned`, wired unconditionally, and lands in every instance
 * verbatim. Before this fix, `loadDistributionInventory` threw on the
 * file's absence there — turning a template-only concept into a permanently
 * red, required check on every future instance PR (confirmed live on
 * tabsii-platform after upgrading to core 0.302.1+). `isInstanceRepo()` is
 * this repo's own established discriminator for "is this checkout the
 * template or an instance" (`cli/src/lib/core-version.ts`, used throughout
 * this package, and the same marker `check-orphan-ratchet-instance.sh`'s own
 * top-of-file skip already uses for the identical template-vs-instance
 * question) — reused here rather than inventing a third detection story.
 * The file-absence check right after it is a defensive second layer for any
 * other checkout that legitimately has neither `biffo.core.json` nor this
 * registry (a fresh non-instance clone missing the file for some other
 * reason should still get a clean skip, not a throw).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from '../lib/exec.js'
import { INSTANCE_CORE_FILE, isInstanceRepo } from '../lib/core-version.js'
import {
  INVENTORY_FILENAME,
  loadDistributionInventory,
  validateInventory,
} from '../lib/distribution-inventory.js'

export async function runDistributionInventoryCheck(root?: string): Promise<void> {
  const repoRoot = root ?? (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  if (isInstanceRepo(repoRoot)) {
    console.log(
      `✓ distribution-inventory: skipped — this is an instance (${INSTANCE_CORE_FILE} present). ` +
        `${INVENTORY_FILENAME} is a template-only registry of the channels biffo-template itself ` +
        'uses to distribute to OTHER repos; it is not declared template-owned or user-owned in ' +
        'core-manifest.json, so biffo core upgrade never carries it and no instance is meant to ' +
        'hold one. Nothing to check here.',
    )
    return
  }

  if (!existsSync(join(repoRoot, INVENTORY_FILENAME))) {
    console.log(
      `✓ distribution-inventory: skipped — no ${INVENTORY_FILENAME} at ${repoRoot}. This is a ` +
        'template-only registry; a checkout that legitimately has none has nothing for this ' +
        'guard to check.',
    )
    return
  }

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
