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
 * this command exposes (`--template`) — the same spelling `core upgrade` now
 * accepts too, as an alias for its canonical `--template-repo` (#1138) — with a
 * complete invocation. Every `--flag` it names must be a real option on
 * `coreDiffCommand`; `error-flag-consistency.test.ts` enforces that (#324).
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
  .option('--json', 'Emit the classification as JSON on stdout instead of the human report')
  .action(async (options: { cwd?: string; template?: string; json?: boolean }) => {
    const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
    const runOptions: CoreDiffOptions = { cwd }
    if (options.template) runOptions.templateRoot = resolve(options.template)
    if (options.json) runOptions.json = true
    try {
      await runCoreDiff(runOptions)
    } catch (err) {
      // Errors go to stderr (log.error), so --json's stdout stays parseable
      // even on failure: a consumer sees empty stdout and a non-zero exit,
      // never a half-written document.
      log.error((err as Error).message)
      process.exit(1)
    }
  })

export interface CoreDiffOptions {
  cwd: string
  /** Template checkout to compare against; defaults to the one this CLI ships with. */
  templateRoot?: string
  /** Emit `CoreDiffJson` on stdout instead of the human report. */
  json?: boolean
}

/**
 * The machine-readable contract of `biffo core diff --json` (#696).
 *
 * This exists because the prose report was the only output, so every consumer —
 * an instance's divergence tooling, a governance check, an agent — hand-parsed
 * section headers and indented file lists. That fails *quietly and low*: a parse
 * that drops a line reports fewer divergences than exist and looks authoritative
 * doing it. Revalidating tabsii's `biffo.divergence.json` against core-v0.133.4,
 * an extraction reported 4 undeclared files when the answer was 5 — caught only
 * because the header carried its own count.
 *
 * Buckets mirror `CoreDiff` exactly and carry the same meanings, including
 * `instanceOnly` being distinct from `removed` (#689) — the distinction a
 * consumer most needs and the prose most easily loses.
 */
export interface CoreDiffJson {
  /** Bumped only on a breaking change to this shape, so consumers can fail loudly. */
  schemaVersion: 1
  /** The instance's recorded core version, or `null` when it records none. */
  instanceCore: string | null
  templateCore: string
  /** Present in both, content differs — an upgrade three-way merges these. */
  modified: string[]
  /** Present in the template, absent here — an upgrade adds these. */
  added: string[]
  /** The template shipped this and later dropped it — an upgrade deletes it. */
  removed: string[]
  /** Present here, never in the template. An upgrade leaves these alone (#689). */
  instanceOnly: string[]
  /** Count of template-owned files that match. */
  unchanged: number
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

  if (options.json) {
    // Nothing else may reach stdout on this path — not the banner, not the
    // "no changes" success line — or the document stops being parseable.
    const payload: CoreDiffJson = {
      schemaVersion: 1,
      instanceCore: instanceVersion ?? null,
      templateCore: templateVersion,
      modified: diff.modified,
      added: diff.added,
      removed: diff.removed,
      instanceOnly: diff.instanceOnly,
      unchanged: diff.unchanged,
    }
    console.log(JSON.stringify(payload, null, 2))
    return
  }

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
  // Listed separately and NOT counted as a change: an upgrade neither carries
  // nor deletes these (#689). Folding them into `removed` read as imminent data
  // loss for files an instance legitimately authored.
  printGroup('instance-only', diff.instanceOnly, chalk.cyan)
  if (diff.instanceOnly.length > 0) {
    console.log(
      chalk.dim(
        `  ${diff.instanceOnly.length} instance-only file(s): present here, never in the template.\n` +
          '  An upgrade leaves these alone — it deletes a path only when the template\n' +
          '  shipped it and later dropped it. They are not pending changes.\n',
      ),
    )
  }

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
