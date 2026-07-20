import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guard against scaffolding from a stale `cli/dist` (issue #190).
 *
 * `biffo init` and `biffo sibling create` are run as `node cli/dist/index.js`
 * against a developer-built bundle that has to be refreshed by hand. Nothing
 * verified it was current, so a `dist` built before a template change would mix
 * *fresh* on-disk skeleton files with *stale* compiled constants and silently
 * create real GitHub repos / AWS resources from out-of-date logic. That is
 * exactly how #189 produced a repo whose branch protection required CI contexts
 * no job reports — permanently unmergeable, with every check green.
 *
 * Signal: modification times. `dist/index.js` must be at least as new as the
 * newest non-test source file under `src/`. mtime is chosen over a build-time
 * git SHA because it also catches *uncommitted* edits — the common developer
 * case — needs no build-script changes, and cannot go stale itself.
 *
 * The check only applies when all three of these hold, so legitimate flows are
 * untouched:
 *
 *  - We are executing the built bundle (this module resolves inside `dist/`).
 *    Running from source via `tsx`/`vitest` compiles on the fly; there is no
 *    build to be stale.
 *  - `src/` exists alongside it. A package installed from npm ships `dist` only
 *    (see the `files` field in package.json), so there is nothing to compare
 *    against and nothing to be stale relative to — it returns `skipped`, never
 *    a false positive.
 *  - The escape hatch is not set. `BIFFO_SKIP_BUILD_FRESHNESS_CHECK=1` opts out
 *    explicitly and loudly; it is never implied.
 */

export const SKIP_ENV_VAR = 'BIFFO_SKIP_BUILD_FRESHNESS_CHECK'

export type BuildFreshnessStatus = 'fresh' | 'stale' | 'skipped'

export interface BuildFreshnessResult {
  status: BuildFreshnessStatus
  /** Why the check was skipped, or how the build is stale. */
  reason: string
  /** Source files newer than the build, newest first (stale only). */
  newerSources: string[]
}

export interface BuildFreshnessOptions {
  /** URL of the module doing the checking; defaults to this file. */
  moduleUrl?: string
  env?: Record<string, string | undefined>
}

/**
 * Decide whether the compiled `dist` this process is running from is current
 * with respect to `src`. Pure with respect to its inputs — it only reads the
 * filesystem and the environment it is handed.
 */
export function checkBuildFreshness(options: BuildFreshnessOptions = {}): BuildFreshnessResult {
  const env = options.env ?? process.env
  if (env[SKIP_ENV_VAR] === '1' || env[SKIP_ENV_VAR] === 'true') {
    return { status: 'skipped', reason: `${SKIP_ENV_VAR} is set`, newerSources: [] }
  }

  const moduleUrl = options.moduleUrl ?? import.meta.url
  const moduleDir = dirname(fileURLToPath(moduleUrl))
  const packageRoot = findPackageRoot(moduleDir)
  if (!packageRoot) {
    return { status: 'skipped', reason: `no package.json above ${moduleDir}`, newerSources: [] }
  }

  const distDir = join(packageRoot, 'dist')
  if (!isInside(distDir, moduleDir)) {
    return {
      status: 'skipped',
      reason: 'running from source, not a build',
      newerSources: [],
    }
  }

  const srcDir = join(packageRoot, 'src')
  if (!existsSync(srcDir)) {
    return {
      status: 'skipped',
      reason: 'no src/ alongside dist/ — this is a shipped package',
      newerSources: [],
    }
  }

  const entry = join(distDir, 'index.js')
  if (!existsSync(entry)) {
    return { status: 'skipped', reason: `${entry} not found`, newerSources: [] }
  }
  const builtAt = statSync(entry).mtimeMs

  const newer = collectSourceFiles(srcDir)
    .map((file) => ({ file, mtimeMs: statSync(file).mtimeMs }))
    .filter((f) => f.mtimeMs > builtAt)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((f) => relative(packageRoot, f.file))

  if (newer.length === 0) {
    return { status: 'fresh', reason: 'dist is newer than src', newerSources: [] }
  }
  return {
    status: 'stale',
    reason: `${newer.length} source file(s) changed since dist/index.js was built`,
    newerSources: newer,
  }
}

/**
 * Refuse to continue when the build is stale. Fails closed and loudly: the whole
 * point of #190 is that a stale run must never proceed silently.
 */
export function assertBuildIsFresh(options: BuildFreshnessOptions = {}): void {
  const result = checkBuildFreshness(options)
  if (result.status !== 'stale') return
  throw new Error(formatStaleBuildError(result))
}

export function formatStaleBuildError(result: BuildFreshnessResult): string {
  const shown = result.newerSources.slice(0, 5)
  const extra = result.newerSources.length - shown.length
  const lines = [
    'Refusing to run: the compiled CLI (cli/dist) is older than its source (cli/src).',
    '',
    `${result.reason}:`,
    ...shown.map((f) => `  - ${f}`),
    ...(extra > 0 ? [`  … and ${extra} more`] : []),
    '',
    'This command creates real GitHub repositories and AWS resources. A stale build',
    'mixes fresh on-disk template files with out-of-date compiled logic and produces',
    'subtly broken projects (see issue #190).',
    '',
    'Rebuild first:',
    '  pnpm --filter biffo build',
    '',
    `To override anyway (you should not need to), set ${SKIP_ENV_VAR}=1.`,
  ]
  return lines.join('\n')
}

/** Non-test TypeScript sources — the files that actually end up in the bundle. */
function collectSourceFiles(srcDir: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (!/\.(ts|mts|cts|json)$/.test(entry.name)) continue
      if (/\.test\.ts$/.test(entry.name)) continue
      if (entry.name === 'test-setup.ts') continue
      found.push(full)
    }
  }
  walk(srcDir)
  return found
}

function findPackageRoot(from: string): string | null {
  let dir = from
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function isInside(parent: string, child: string): boolean {
  if (child === parent) return true
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`)
}
