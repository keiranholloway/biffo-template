/**
 * Re-sorting a scaffolded plugin's imports after token substitution (biffo-template#2134).
 *
 * The skeleton's import order is right only for the placeholder `example_plugin`. Substitution renames modules, and
 * isort orders imports by module name (and, per the ruff `src` setting, sections them first-party vs third-party), so
 * `from biffo_plugin_sdk import …` / `from a5_throwaway_fakes import …` lands unsorted for a name that sorts differently.
 * The instance's required lint (`select` includes `I`) then fails on a raw scaffold with no hand edit involved.
 *
 * Ordering cannot be made name-independent in the skeleton: where a name falls relative to `biffo_plugin_sdk` decides
 * the order, and the section a module belongs to depends on the ruff config of wherever the plugin lands (an in-tree
 * plugin and a standalone repo classify `<pkg>` differently). So the ordering is computed by the tool that enforces it:
 * `ruff check --select I --fix` over the scaffolded `.py` files, resolved per file against the plugin's own
 * `[tool.ruff]` — the same configuration the instance's check will apply. Nothing here re-implements isort.
 */
import { execa } from './exec.js'
import { log } from './logger.js'

export async function sortScaffoldedImports(destDir: string, pythonFiles: string[]): Promise<void> {
  if (pythonFiles.length === 0) return
  const manual = `Run \`uvx ruff check --select I --fix ${destDir}\` before committing.`
  try {
    // `uvx` rather than the instance's own `uv run ruff`: no venv is needed and the plugin dir may not be resolvable yet.
    await execa(
      'uvx',
      ['ruff', 'check', '--select', 'I', '--fix', '--no-cache', '--quiet', ...pythonFiles],
      {
        cwd: destDir,
      },
    )
  } catch (err) {
    const cause = err as NodeJS.ErrnoException & { stderr?: string }
    if (cause.code === 'ENOENT') {
      // Not fatal to the scaffold, but never silent: without this pass the file may fail the instance's lint.
      log.warn(`\`uv\` is not on PATH, so the scaffold's imports were not re-sorted. ${manual}`)
      return
    }
    throw new Error(
      `Failed to sort the scaffold's imports (ruff isort pass): ${cause.stderr?.trim() || (err as Error).message}. ${manual}`,
    )
  }
}
