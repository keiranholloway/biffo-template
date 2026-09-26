/**
 * Invokes the Core API's plugin-migration generator
 * (services/api/scripts/generate_plugin_migrations.py, a thin wrapper around
 * services/api/src/api/migrations/plugin_migrations.py's
 * sync_plugin_migrations) to write a real, git-committed Alembic migration
 * file into services/api/migrations/versions/ for one or more installed
 * plugins.
 *
 * Deliberately shells out to `uv run python` rather than reimplementing
 * generate_migration_for_plugin's Alembic-text generation and safe
 * type-string parsing (ast.literal_eval-based, quote-escaping to prevent
 * code injection into the generated .py file) in TypeScript — that logic
 * never opens a DB connection (pure string templating + file write, no
 * ADR-0002 concern), and porting it would mean maintaining two independent
 * implementations of the same revision-hashing/codegen in permanent
 * lockstep. This is the one place the CLI requires a local Python/uv
 * toolchain; every other command remains Node-only. `scripts/bootstrap.sh`
 * (documented first-time setup) already installs uv unconditionally, so a
 * developer following the documented setup already has it.
 */
import { execa } from '../../lib/exec.js'
import { join } from 'node:path'

export class PluginMigrationsAdapter {
  /**
   * Generates migration file(s) for `pluginNames` (every discovered
   * installed plugin if omitted), returning the absolute path of each newly
   * generated file — empty if every named plugin already had a migration,
   * or declared no tables.
   */
  async generate(cwd: string, pluginNames?: string[]): Promise<string[]> {
    const scriptPath = join(cwd, 'services', 'api', 'scripts', 'generate_plugin_migrations.py')
    const args = [
      'run',
      'python',
      scriptPath,
      '--services-root',
      join(cwd, 'services'),
      '--versions-dir',
      join(cwd, 'services', 'api', 'migrations', 'versions'),
    ]
    for (const name of pluginNames ?? []) {
      args.push('--plugin', name)
    }

    const result = await runUv(args, join(cwd, 'services', 'api'), {
      missing:
        'biffo plugin install/upgrade/sync-migrations needs `uv` (Python) on PATH to ' +
        'generate a real migration file — see https://docs.astral.sh/uv/ to install it. ' +
        'Once installed, re-run this command (or `biffo plugin sync-migrations <name>` ' +
        'if services/<name>/ is already copied in).',
      failed: 'Failed to generate plugin migration',
    })

    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  }

  /**
   * Brings the instance's root `uv.lock` in step with its workspace (`uv lock`).
   *
   * `plugin install` adds a member to the uv workspace, so the committed lock is stale the moment the plugin lands — whether or
   * not the plugin has tables (only a table-bearing plugin runs `uv run` for a migration, which is a side effect that happens to
   * re-lock). Locking explicitly, then staging the result, is what makes `uv lock --check` pass on the install commit
   * (biffo-template#2106); leaving it to whichever `uv run` came last is how the no-tables install shipped a stale lock.
   */
  async refreshLock(cwd: string): Promise<void> {
    await runUv(['lock'], cwd, {
      missing:
        'biffo plugin install needs `uv` (Python) on PATH to refresh uv.lock for the workspace member it adds — ' +
        'see https://docs.astral.sh/uv/ to install it, then run `uv lock` and commit uv.lock yourself.',
      failed: 'Failed to refresh uv.lock (`uv lock`)',
    })
  }
}

/** Runs `uv <args>` in `cwd`, turning a missing binary and a non-zero exit into actionable errors. */
async function runUv(
  args: string[],
  cwd: string,
  messages: { missing: string; failed: string },
): Promise<{ stdout: string }> {
  try {
    return await execa('uv', args, { cwd })
  } catch (err) {
    const cause = err as NodeJS.ErrnoException & { stderr?: string }
    if (cause.code === 'ENOENT') throw new Error(messages.missing)
    throw new Error(`${messages.failed}: ${cause.stderr?.trim() || (err as Error).message}`)
  }
}
