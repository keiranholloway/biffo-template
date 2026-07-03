import { join, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { readCoreManifest, resolveTemplateRoot } from '../lib/core-manifest.js'
import { readCoreVersionFile, readInstanceCoreVersion } from '../lib/core-version.js'
import { type UpgradePlan, planCoreUpgrade } from '../lib/core-upgrade.js'
import { log } from '../lib/logger.js'

export const coreUpgradeCommand = new Command('upgrade')
  .description(
    'Plan a core upgrade: three-way-merge template-owned files and report what would change (dry run)',
  )
  .option('--cwd <path>', 'Instance repo root to upgrade (defaults to the current directory)')
  .requiredOption(
    '--from-template <path>',
    'Path to a biffo-template checkout at the instance’s CURRENT core version (the merge base)',
  )
  .option(
    '--to-template <path>',
    'Path to a biffo-template checkout at the TARGET core version (defaults to the template this CLI ships with)',
  )
  .action(async (options: { cwd?: string; fromTemplate: string; toTemplate?: string }) => {
    const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
    const runOptions: CoreUpgradeOptions = {
      cwd,
      baseDir: resolve(options.fromTemplate),
    }
    if (options.toTemplate) runOptions.theirsDir = resolve(options.toTemplate)
    try {
      await runCoreUpgrade(runOptions)
    } catch (err) {
      log.error((err as Error).message)
      process.exit(1)
    }
  })

export interface CoreUpgradeOptions {
  cwd: string
  /** Template checkout at the instance's current version (merge base). */
  baseDir: string
  /** Template checkout at the target version; defaults to the shipped template. */
  theirsDir?: string
}

/**
 * ADR-0006 Phase 3a: compute and report the three-way-merge plan for a core
 * upgrade. Read-only — writes nothing. Applying the plan to a branch and
 * opening a PR on the instance repo is Phase 3b.
 */
export async function runCoreUpgrade(options: CoreUpgradeOptions): Promise<void> {
  const theirsDir = options.theirsDir ?? resolveTemplateRoot()
  // The manifest that governs ownership comes from the target template.
  const manifest = readCoreManifest(theirsDir)

  const fromVersion = readCoreVersionFile(join(options.baseDir, 'core.version'))
  const toVersion = readCoreVersionFile(join(theirsDir, 'core.version'))
  const instanceVersion = readInstanceCoreVersion(options.cwd)

  const plan = await planCoreUpgrade({
    baseDir: options.baseDir,
    oursDir: options.cwd,
    theirsDir,
    manifest,
  })

  console.log(chalk.bold('\n  Biffo core upgrade (dry run)\n'))
  console.log(`  instance core:   ${instanceVersion ?? chalk.dim('(unrecorded)')}`)
  console.log(`  merge base:      ${fromVersion}`)
  console.log(`  target:          ${toVersion}\n`)

  if (plan.changes.length === 0) {
    log.success('Nothing to upgrade — the instance already matches the target for all core files.')
    return
  }

  printPlan(plan)

  console.log(
    `\n  ${chalk.bold(String(plan.changes.length))} change(s), ` +
      `${plan.conflicts.length > 0 ? chalk.red(String(plan.conflicts.length) + ' conflict(s)') : chalk.green('0 conflicts')}.`,
  )

  if (plan.conflicts.length > 0) {
    log.warn('Some core files changed on both sides and need manual resolution.')
  }
  console.log(
    chalk.dim(
      '\n  Dry run — nothing was written. Applying this plan to a branch and opening a\n' +
        '  PR on the instance repo is ADR-0006 Phase 3b.\n',
    ),
  )
}

const STATUS_COLOR: Record<string, (s: string) => string> = {
  conflict: chalk.red,
  'add-conflict': chalk.red,
  'remove-conflict': chalk.red,
  merged: chalk.yellow,
  'take-theirs': chalk.green,
  added: chalk.green,
  removed: chalk.red,
  'keep-ours': chalk.dim,
}

function printPlan(plan: UpgradePlan): void {
  // Conflicts first, then the rest of the changes.
  const ordered = [...plan.conflicts, ...plan.changes.filter((c) => !c.conflicted)]
  for (const e of ordered) {
    const color = STATUS_COLOR[e.status] ?? ((s: string) => s)
    console.log(`  ${color(e.status.padEnd(15))} ${e.path}`)
  }
}
