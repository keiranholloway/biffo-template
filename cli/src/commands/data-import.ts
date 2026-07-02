import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import inquirer from 'inquirer'
import { GitAdapter } from '../adapters/git/index.js'
import { log } from '../lib/logger.js'

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/

export const dataImportCommand = new Command('import')
  .description(
    'Import a directory of DDL .sql files: biffo data import <name> --source <local-dir-or-github-url>',
  )
  .argument('<name>', 'Name for this DDL import, e.g. tabsii')
  .requiredOption(
    '--source <path-or-url>',
    'Local directory, or a GitHub repo URL (https://github.com/org/repo)',
  )
  .option(
    '--path <subdir>',
    'Subdirectory containing .sql files — within the local directory or the cloned repo',
  )
  .option('--token <pat>', 'GitHub Personal Access Token, for a private repo --source')
  .option('--dry-run', 'Resolve the source and print planned changes without modifying the repo')
  .option('--cwd <path>', 'Project root to import into (defaults to the current directory)')
  .action(
    async (
      name: string,
      options: { source: string; path?: string; token?: string; dryRun?: boolean; cwd?: string },
    ) => {
      const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
      try {
        await runDataImport(
          name,
          {
            source: options.source,
            path: options.path,
            token: options.token,
            dryRun: options.dryRun ?? false,
            cwd,
          },
          { git: new GitAdapter() },
        )
      } catch (err) {
        log.error((err as Error).message)
        process.exit(1)
      }
    },
  )

export interface DataImportDeps {
  git: GitAdapter
}

export interface DataImportOptions {
  source: string
  path?: string | undefined
  token?: string | undefined
  dryRun: boolean
  cwd: string
}

/**
 * Vendors a directory of `.sql` DDL files into the current Biffo project
 * checkout at `db/imports/<name>/`, then commits — the same "vendor and
 * commit" model plugin-install.ts already uses for
 * services/<name>/, just for raw SQL instead of a plugin's source tree (see
 * docs/ADR/0005-ddl-import-module.md).
 *
 * Two source modes:
 *   - `--source` resolves to an existing local directory: used directly, no
 *     clone, no token needed.
 *   - otherwise treated as a git URL: cloned to a temp dir via
 *     GitAdapter.cloneToTemp (token-aware for private repos).
 *
 * In either mode, only `*.sql` files directly under the resolved source (or
 * its `--path` subdirectory) are copied — not the whole source tree — so a
 * README/NOTES.md alongside the DDL in the source repo doesn't get vendored
 * too. Sort order (apply order, set by `biffo data apply`) is filename
 * order, hence the warning below when files don't look sortable.
 *
 * Does not push, deploy, or apply anything — matches plugin-install.ts's
 * "vendor and commit only" scope exactly. Applying the files against a real
 * database is `biffo data apply`.
 */
export async function runDataImport(
  name: string,
  options: DataImportOptions,
  deps: DataImportDeps,
): Promise<void> {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid import name '${name}'. Use lowercase letters, numbers, and hyphens, starting with a letter.`,
    )
  }

  const servicesDir = join(options.cwd, 'services')
  if (!existsSync(servicesDir)) {
    throw new Error(
      `${servicesDir} does not exist — is ${options.cwd} the root of a Biffo project checkout?`,
    )
  }

  const targetDir = join(options.cwd, 'db', 'imports', name)
  if (existsSync(targetDir)) {
    throw new Error(
      `DDL import '${name}' is already present at db/imports/${name}/. ` +
        `Remove it first to re-import.`,
    )
  }

  const isLocalDir = existsSync(options.source) && statSync(options.source).isDirectory()

  let sourceDir: string
  let cleanupClone: (() => void) | null = null

  if (isLocalDir) {
    sourceDir = options.path ? join(options.source, options.path) : options.source
  } else {
    const token = options.token ?? (await resolveDdlImportToken())
    log.info(`Cloning ${options.source}...`)
    const tmpDir = await deps.git.cloneToTemp(options.source, `biffo-data-${name}`, token)
    cleanupClone = () => {
      deps.git.cleanup(tmpDir)
    }
    sourceDir = options.path ? join(tmpDir, options.path) : tmpDir
  }

  try {
    if (!existsSync(sourceDir)) {
      throw new Error(`Source directory does not exist: ${sourceDir}`)
    }

    const sqlFiles = readdirSync(sourceDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort()

    if (sqlFiles.length === 0) {
      throw new Error(`No .sql files found at ${sourceDir}.`)
    }

    const unsortable = sqlFiles.filter((f) => !/^\d/.test(f))
    if (unsortable.length > 0) {
      log.warn(
        `${unsortable.length} file(s) don't start with a digit (e.g. '000_', '001_') — apply ` +
          `order is alphabetical by filename, so files without a numeric prefix may not sort as ` +
          `intended: ${unsortable.join(', ')}`,
      )
    }

    if (options.dryRun) {
      printDryRun(name, sqlFiles)
      return
    }

    const isRepo = await deps.git.isGitRepo(options.cwd)
    if (!isRepo) {
      throw new Error(
        `${options.cwd} is not a git repository — biffo data import must be run from a Biffo project checkout.`,
      )
    }

    mkdirSync(targetDir, { recursive: true })
    for (const file of sqlFiles) {
      cpSync(join(sourceDir, file), join(targetDir, file))
    }
    log.success(`Imported ${String(sqlFiles.length)} .sql file(s) to db/imports/${name}/`)

    const commitMessage = `feat(data): import ${name} (${String(sqlFiles.length)} SQL file(s))`
    await deps.git.add(options.cwd, [`db/imports/${name}`])
    await deps.git.commit(options.cwd, commitMessage)
    log.success(`Committed: ${commitMessage}`)

    console.log(chalk.bold('\n  Data import staged!\n'))
    console.log(
      `  ${name} (${String(sqlFiles.length)} file(s)) is committed at db/imports/${name}/`,
    )
    console.log('  Push and redeploy to bundle it into the Lambda, then apply it:')
    console.log(chalk.dim(`    git push`))
    console.log(chalk.dim(`    biffo deploy <environment> --app-only`))
    console.log(chalk.dim(`    biffo data apply ${name} --env <environment>\n`))
  } finally {
    cleanupClone?.()
  }
}

/**
 * `--token` flag → BIFFO_DATA_IMPORT_TOKEN env var → `gh auth token` →
 * interactive masked prompt — same layered pattern deploy.ts's
 * resolveGithubToken() and init.ts's token flow already use, kept as its
 * own distinct flow (not shared) since this token's scope/org may differ
 * from the main GITHUB_TOKEN used for repo administration: it only ever
 * needs read access to clone one repo, nothing like `admin:org`/`workflow`.
 *
 * Unlike resolveGithubToken() (mandatory — deploy.ts can't proceed without
 * some token), this is optional: many DDL sources are public repos needing
 * no auth at all, so an empty prompt answer is accepted and returns
 * `undefined` rather than erroring.
 */
async function resolveDdlImportToken(): Promise<string | undefined> {
  if (process.env['BIFFO_DATA_IMPORT_TOKEN']) return process.env['BIFFO_DATA_IMPORT_TOKEN']

  try {
    const token = execSync('gh auth token', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim()
    if (token) return token
  } catch {
    /* gh not installed or not authenticated */
  }

  const { token } = await inquirer.prompt<{ token: string }>([
    {
      type: 'password',
      name: 'token',
      message:
        'GitHub Personal Access Token for the source repo (read-only "repo" scope; leave blank if public):',
      mask: '*',
    },
  ])
  return token.trim() || undefined
}

function printDryRun(name: string, sqlFiles: string[]): void {
  console.log(chalk.bold('\n  Dry run — no changes will be made\n'))
  console.log(`  Import name:   ${name}`)
  console.log(`  SQL files (${String(sqlFiles.length)}):`)
  for (const file of sqlFiles) {
    console.log(`    ${file}`)
  }
  console.log(`  Would copy into: db/imports/${name}/`)
  console.log(
    `  Would commit:  feat(data): import ${name} (${String(sqlFiles.length)} SQL file(s))\n`,
  )
}
