/**
 * Copies a local, unpublished plugin checkout into the target monorepo for
 * `biffo plugin install --local` and `biffo plugin upgrade --local` (#1477).
 *
 * The source is a real working directory, not a temp clone `GitAdapter`
 * has already stripped `.git` from (`cloneAndValidatePlugin`) — so unlike
 * the registry path, this copy has to decide for itself what belongs in the
 * instance and what doesn't.
 *
 * Two mechanisms were on the table:
 *
 * 1. A hardcoded denylist of directory names to skip (the original
 *    `LOCAL_COPY_EXCLUDES`, kept here as a fallback — see below).
 * 2. Ask git what the checkout considers real: `git ls-files --cached
 *    --others --exclude-standard`, which lists tracked files *and*
 *    untracked-but-not-ignored ones, and — critically — silently omits
 *    everything `.gitignore` excludes.
 *
 * (2) is the primary mechanism, deliberately, not (1). A denylist only ever
 * covers the caches and VCS detritus someone thought to name; a `.worktrees/`
 * directory, an unfamiliar tool's new cache directory, or a `.venv` under a
 * name nobody added to the list is invisible to it — which is exactly how
 * #1477 happened: `.worktrees/` (git-ignored in every plugin repo per
 * AGENTS.md §2) and `.ruff_cache/` were vendored into `tabsii-platform`
 * wholesale, complete with two other agents' in-progress branches. Reading
 * `.gitignore` (via git, so its precedence rules — negation, nested
 * `.gitignore`s — are honoured exactly as the source repo intends, rather
 * than reimplemented) gets every current and future ignored path excluded
 * for free, with no list to maintain and no new cache directory able to slip
 * through unnoticed.
 *
 * A local plugin directory is not guaranteed to be a git checkout, though —
 * `biffo plugin create` scaffolds one with no `git init` step, and nothing
 * requires a directory passed to `--local` to be one. `git ls-files` doesn't
 * fail loudly in that case, it just isn't git at all, so this checks
 * `git rev-parse --is-inside-work-tree` first and falls back to the old
 * denylist copy (`LOCAL_COPY_EXCLUDES`) with a warning, rather than crashing
 * or silently vendoring everything unfiltered.
 */
import { copyFileSync, cpSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { execa } from 'execa'
import { log } from './logger.js'

/**
 * Build/VCS detritus never copied out of a local plugin directory that is
 * NOT a git working tree — the fallback path only. When the source is a git
 * checkout, `.gitignore` (read via `git ls-files`) is the source of truth
 * instead, since it categorically subsumes this list without needing it kept
 * in sync with whatever caches a plugin's tooling grows over time.
 */
export const LOCAL_COPY_EXCLUDES = new Set([
  '.git',
  '.venv',
  'node_modules',
  '__pycache__',
  '.ruff_cache',
  '.pytest_cache',
  '.mypy_cache',
  'dist',
  '.terraform',
])

export interface CopyPluginSourceResult {
  /** True if the copy was filtered via `git ls-files` (the primary path). */
  usedGitIgnoreRules: boolean
}

/**
 * Copies every real file under `sourceDir` into `targetDir`, honouring the
 * source's `.gitignore` when it is a git working tree, and falling back to
 * the denylist when it is not. `targetDir` is assumed to already exist (or
 * be creatable) and empty of anything the caller wants to keep — this
 * function does not remove existing content, matching `cpSync`'s own
 * contract.
 */
export async function copyPluginSource(
  sourceDir: string,
  targetDir: string,
): Promise<CopyPluginSourceResult> {
  if (await isGitWorkingTree(sourceDir)) {
    const files = await listGitFiles(sourceDir)
    for (const relPath of files) {
      const destPath = join(targetDir, relPath)
      mkdirSync(dirname(destPath), { recursive: true })
      copyFileSync(join(sourceDir, relPath), destPath)
    }
    return { usedGitIgnoreRules: true }
  }

  log.warn(
    `${sourceDir} is not a git working tree — cannot honour .gitignore. ` +
      'Falling back to a fixed exclude list (.git, .venv, node_modules, caches); ' +
      'anything else it does not know about (e.g. an unfamiliar cache directory) will be copied.',
  )
  mkdirSync(targetDir, { recursive: true })
  cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (src) => !LOCAL_COPY_EXCLUDES.has(basename(src)),
  })
  return { usedGitIgnoreRules: false }
}

async function isGitWorkingTree(dir: string): Promise<boolean> {
  try {
    await execa('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir })
    return true
  } catch {
    return false
  }
}

/**
 * Tracked files plus untracked-but-not-ignored ones, exactly what a `git
 * add -A` in `sourceDir` would pick up — which is the right set here: a
 * plugin mid-iteration legitimately has real, uncommitted new files that
 * must still be copied, only ignored ones must not be.
 *
 * NUL-delimited (`-z`) so a path containing a space or unusual character
 * can't be split wrong.
 */
async function listGitFiles(dir: string): Promise<string[]> {
  const { stdout } = await execa(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: dir },
  )
  return stdout.split('\0').filter((p) => p.length > 0)
}
