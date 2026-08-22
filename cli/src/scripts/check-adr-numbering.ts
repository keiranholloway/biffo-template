/**
 * CI entrypoint for the ADR numbering guard: fail when two files in this
 * repo's own `docs/ADR/` claim the same numeric prefix (tabsii-platform#449),
 * when an INSTANCE repo has a new ADR numbered inside the template's reserved
 * range (#1105), or when `docs/ADR/.numbering-allowlist` names a number
 * neither check needs any more.
 *
 * A no-op in a repo with no `docs/ADR/`, or where every prefix is unique and
 * (for an instance) none land in the reserved range — including this
 * template, which has one series by construction and is never checked
 * against its own reserved range (see adr-numbering-guard.ts's module doc
 * comment, "The reserved range").
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from '../lib/exec.js'
import {
  ALLOWLIST_FILENAME,
  findAdrNumberCollisions,
  findAdrReservedRangeViolations,
  findStaleAdrNumberingAllowlistEntries,
  formatAdrNumberCollisions,
  formatAdrReservedRangeViolations,
} from '../lib/adr-numbering-guard.js'
import { isInstanceRepo } from '../lib/core-version.js'

export async function runAdrNumberingCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
  const adrDir = join(root, 'docs', 'ADR')

  if (!existsSync(adrDir)) {
    console.log('✓ ADR numbering guard: no docs/ADR/ directory — nothing to compare')
    return
  }

  const instance = isInstanceRepo(root)
  const collisions = findAdrNumberCollisions(adrDir)
  const reservedRangeViolations = instance ? findAdrReservedRangeViolations(adrDir) : []
  const stale = findStaleAdrNumberingAllowlistEntries(adrDir, { isInstance: instance })
  let failed = false

  if (collisions.length > 0) {
    failed = true
    console.error('✗ ADR numbering guard: two ADRs in docs/ADR/ share a number\n')
    console.error(formatAdrNumberCollisions(collisions))
    console.error(
      `\nAlready accepted? List it in docs/ADR/${ALLOWLIST_FILENAME} instead of leaving this red ` +
        'forever. See tabsii-platform#449 for how this class of collision happens.',
    )
  }

  if (reservedRangeViolations.length > 0) {
    failed = true
    console.error(
      "✗ ADR numbering guard: docs/ADR/ has an ADR inside the template's reserved range\n",
    )
    console.error(formatAdrReservedRangeViolations(reservedRangeViolations))
    console.error('\nSee #1105 for why this range is reserved.')
  }

  if (stale.length > 0) {
    failed = true
    console.error(
      `✗ ADR numbering guard: docs/ADR/${ALLOWLIST_FILENAME} names a number that ` +
        `neither check needs any more: ${stale.join(', ')}\n` +
        '  Remove the stale entry — an allowlist nothing checks against just hides the next real one.',
    )
  }

  if (failed) process.exit(1)

  console.log('✓ ADR numbering guard: OK')
}
