import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import {
  type CoreDiff,
  computeCoreDiff,
  readCoreManifest,
  resolveTemplateRoot,
} from '../lib/core-manifest.js'
import {
  CORE_VERSION_FILE,
  latestCoreVersionFromTags,
  readCoreVersionFile,
  readInstanceCoreVersion,
} from '../lib/core-version.js'
import { log } from '../lib/logger.js'

/**
 * Guidance shown when `core diff` cannot find a template root. It names the flag
 * this command exposes (`--template`) — distinct from `core upgrade`'s
 * `--template-repo` — with a complete invocation. Every `--flag` it names must
 * be a real option on `coreDiffCommand`; `error-flag-consistency.test.ts`
 * enforces that (#324).
 */
export const MISSING_TEMPLATE_ROOT_GUIDANCE =
  'Pass --template <path> to a biffo-template checkout, e.g. ' +
  '`biffo core diff --template /path/to/biffo-template`.'

export const coreDiffCommand = new Command('diff')
  .description(
    'Show which template-owned files an upgrade would change in this instance (read-only)',
  )
  .option('--cwd <path>', 'Instance repo root to inspect (defaults to the current directory)')
  .option(
    '--template <path>',
    'Path to a biffo-template checkout to compare against (defaults to the template this CLI ships with)',
  )
  .action(async (options: { cwd?: string; template?: string }) => {
    const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
    const runOptions: CoreDiffOptions = { cwd }
    if (options.template) runOptions.templateRoot = resolve(options.template)
    try {
      await runCoreDiff(runOptions)
    } catch (err) {
      log.error((err as Error).message)
      process.exit(1)
    }
  })

export interface CoreDiffOptions {
  cwd: string
  /** Template checkout to compare against; defaults to the one this CLI ships with. */
  templateRoot?: string
}

/**
 * Read-only: reports the template-owned files that differ between this instance
 * and the template (ADR-0006 Phase 2). Writes nothing and touches no network —
 * it's the preview that `biffo core upgrade` (Phase 3) will turn into a PR.
 */
export async function runCoreDiff(options: CoreDiffOptions): Promise<void> {
  const templateRoot =
    options.templateRoot ?? resolveTemplateRoot({ guidance: MISSING_TEMPLATE_ROOT_GUIDANCE })
  const manifest = readCoreManifest(templateRoot)

  // The template's current version is its highest core-v* tag (#423); the file
  // is only a fallback for a checkout that predates the switch.
  const templateVersion =
    latestCoreVersionFromTags(templateRoot) ??
    (existsSync(join(templateRoot, CORE_VERSION_FILE))
      ? readCoreVersionFile(join(templateRoot, CORE_VERSION_FILE))
      : '(unreleased)')
  const instanceVersion = readInstanceCoreVersion(options.cwd)

  const diff = computeCoreDiff(templateRoot, options.cwd, manifest)
  const total = diff.added.length + diff.removed.length + diff.modified.length

  console.log(chalk.bold('\n  Biffo core diff\n'))
  console.log(`  instance core:  ${instanceVersion ?? chalk.dim('(unrecorded)')}`)
  console.log(`  template core:  ${templateVersion}\n`)

  if (total === 0) {
    log.success('No template-owned changes — this instance matches the template.')
    return
  }

  printGroup('modified', diff.modified, chalk.yellow)
  printGroup('added', diff.added, chalk.green)
  printGroup('removed', diff.removed, chalk.red)

  console.log(
    `\n  ${chalk.bold(String(total))} template-owned file(s) would change ` +
      `(${diff.modified.length} modified, ${diff.added.length} added, ${diff.removed.length} removed); ` +
      `${chalk.dim(String(diff.unchanged) + ' unchanged')}.`,
  )
  console.log(
    chalk.dim(
      '\n  Read-only preview. `biffo core upgrade` (ADR-0006 Phase 3) will apply a\n' +
        '  three-way merge of these on a branch and open a PR for review.\n',
    ),
  )
}

function printGroup(label: string, files: string[], color: (s: string) => string): void {
  if (files.length === 0) return
  console.log(`  ${color(label)} (${files.length})`)
  for (const f of files) console.log(`    ${f}`)
  console.log()
}

export type { CoreDiff }
