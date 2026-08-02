/**
 * CI entrypoint for the ADR numbering guard (tabsii-platform#449): fail when
 * two files in this repo's own `docs/ADR/` claim the same numeric prefix, or
 * when `docs/ADR/.numbering-allowlist` names a number that isn't actually
 * colliding any more.
 *
 * A no-op in a repo with no `docs/ADR/`, or where every prefix is unique —
 * including this template, which has one series by construction.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import {
  ALLOWLIST_FILENAME,
  findAdrNumberCollisions,
  findStaleAdrNumberingAllowlistEntries,
  formatAdrNumberCollisions,
} from '../lib/adr-numbering-guard.js'

export async function runAdrNumberingCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
  const adrDir = join(root, 'docs', 'ADR')

  if (!existsSync(adrDir)) {
    console.log('✓ ADR numbering guard: no docs/ADR/ directory — nothing to compare')
    return
  }

  const collisions = findAdrNumberCollisions(adrDir)
  const stale = findStaleAdrNumberingAllowlistEntries(adrDir)
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

  if (stale.length > 0) {
    failed = true
    console.error(
      `✗ ADR numbering guard: docs/ADR/${ALLOWLIST_FILENAME} names a number that ` +
        `no longer collides: ${stale.join(', ')}\n` +
        '  Remove the stale entry — an allowlist nothing checks against just hides the next real one.',
    )
  }

  if (failed) process.exit(1)

  console.log('✓ ADR numbering guard: OK')
}
