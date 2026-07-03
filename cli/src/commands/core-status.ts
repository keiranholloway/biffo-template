import { resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import {
  INSTANCE_CORE_FILE,
  compareCoreVersions,
  getLatestCoreVersion,
  readInstanceCoreVersion,
} from '../lib/core-version.js'
import { log } from '../lib/logger.js'

export const coreStatusCommand = new Command('status')
  .description("Show this instance's Biffo core version and whether an upgrade is available")
  .option('--cwd <path>', 'Instance repo root to inspect (defaults to the current directory)')
  .action(async (options: { cwd?: string }) => {
    const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
    try {
      await runCoreStatus({ cwd })
    } catch (err) {
      log.error((err as Error).message)
      process.exit(1)
    }
  })

export interface CoreStatusOptions {
  cwd: string
  /** The latest available core version; defaults to the version this CLI ships
   * with. Injectable so tests don't depend on the monorepo layout. */
  latest?: string
}

/**
 * Read-only: reports the instance's recorded core version (from
 * `biffo.core.json`) against the version this CLI ships with, and whether an
 * upgrade is available. Does not modify anything or touch the network — the
 * ADR-0006 Phase 1 foundation that `biffo core diff` / `biffo core upgrade`
 * (later phases) build on.
 */
export async function runCoreStatus(options: CoreStatusOptions): Promise<void> {
  const latest = options.latest ?? getLatestCoreVersion()
  const current = readInstanceCoreVersion(options.cwd)

  if (current === null) {
    log.warn(`No ${INSTANCE_CORE_FILE} found in ${options.cwd}.`)
    console.log(
      chalk.dim(
        '\n  This does not look like a Biffo instance, or it was scaffolded before core\n' +
          '  versioning existed. Run from an instance repo root, or pass --cwd <path>.\n',
      ),
    )
    return
  }

  console.log(chalk.bold('\n  Biffo core status\n'))
  console.log(`  current (this instance):  ${current}`)
  console.log(`  latest  (this CLI):       ${latest}\n`)

  const cmp = compareCoreVersions(current, latest)
  if (cmp === 0) {
    log.success(`Up to date (${current}).`)
  } else if (cmp < 0) {
    log.info(`Upgrade available: ${current} → ${latest}.`)
    console.log(
      chalk.dim(
        '\n  Preview the changes with `biffo core diff`, then open an upgrade PR with\n' +
          '  `biffo core upgrade` (coming in later ADR-0006 phases).\n',
      ),
    )
  } else {
    log.warn(
      `This instance's core (${current}) is ahead of this CLI (${latest}); update your Biffo CLI.`,
    )
  }
}
