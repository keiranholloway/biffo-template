import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { log } from '../lib/logger.js'

export const dataListCommand = new Command('list')
  .description('List DDL imports vendored in this project checkout')
  .option('--cwd <path>', 'Project root to scan (defaults to the current directory)')
  .action(async (options: { cwd?: string }) => {
    const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
    try {
      await runDataList({ cwd })
    } catch (err) {
      log.error((err as Error).message)
      process.exit(1)
    }
  })

export interface DataListOptions {
  cwd: string
}

interface DdlImportEntry {
  name: string
  fileCount: number
}

/**
 * Lists DDL imports vendored under db/imports/ in the local checkout.
 *
 * Local-only, same scope limitation as plugin-list.ts: "imported" only
 * means "a directory of .sql files was copied into db/imports/<name>/ and
 * committed" — this command has no way to know what's actually been
 * *applied* to any deployed environment's database (that's
 * `biffo data apply <name> --env <environment>`'s own report, which reads
 * live from the deployment, not from the local checkout).
 */
export async function runDataList(options: DataListOptions): Promise<void> {
  const importsDir = join(options.cwd, 'db', 'imports')
  if (!existsSync(importsDir)) {
    console.log(chalk.dim('\n  No DDL imports in this checkout.\n'))
    return
  }

  const candidates = readdirSync(importsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const imports: DdlImportEntry[] = []
  for (const name of candidates) {
    const fileCount = readdirSync(join(importsDir, name)).filter((f) => f.endsWith('.sql')).length
    if (fileCount > 0) imports.push({ name, fileCount })
  }

  if (imports.length === 0) {
    console.log(chalk.dim('\n  No DDL imports in this checkout.\n'))
    return
  }

  const nameWidth = Math.max(...imports.map((i) => i.name.length), 'NAME'.length)

  console.log(chalk.bold(`\n  DDL imports (${String(imports.length)})\n`))
  console.log(`  ${'NAME'.padEnd(nameWidth)}  FILES`)
  for (const imp of imports) {
    console.log(`  ${imp.name.padEnd(nameWidth)}  ${String(imp.fileCount)}`)
  }
  console.log(
    chalk.dim(
      '\n  Note: reflects what has been imported (vendored) into this checkout only — not ' +
        "what's been applied to any deployed environment. Use " +
        '`biffo data apply <name> --env <environment>` to check/apply.\n',
    ),
  )
}
