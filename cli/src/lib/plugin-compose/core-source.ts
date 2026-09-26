import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CommandRunner } from './command-runner.js'

/**
 * Where the composition gets Core from (biffo-template#1522, blocker 1).
 * `biffo-api` is not published and `import api` only works with
 * `PYTHONPATH=services/api/src`, so a plugin repo needs a biffo-template checkout.
 * One Core, no second copy — resolved, in order, from `--core-root`,
 * `BIFFO_CORE_ROOT`, or a shallow checkout of the CLI's own core version tag.
 */
export const CORE_MARKER = join('services', 'api', 'src', 'api', 'main.py')
const CORE_REPO_URL = 'https://github.com/keiranholloway/biffo-template.git'

export function isCoreRoot(dir: string): boolean {
  return existsSync(join(dir, CORE_MARKER))
}

export interface CoreSourceInput {
  explicit?: string
  env: NodeJS.ProcessEnv
  /** The tag to fetch when nothing is supplied, e.g. `core-v0.32.9`. */
  coreTag: string
  cacheDir?: string
  runner: CommandRunner
}

export function resolveCoreRoot(input: CoreSourceInput): string {
  const supplied = input.explicit ?? input.env.BIFFO_CORE_ROOT
  if (supplied) {
    const root = resolve(supplied)
    if (!isCoreRoot(root)) {
      throw new Error(
        `Core root ${root} is not a biffo-template checkout (no ${CORE_MARKER}) — point ` +
          `--core-root / BIFFO_CORE_ROOT at a checkout of biffo-template.`,
      )
    }
    return root
  }
  const cache = join(input.cacheDir ?? join(homedir(), '.cache', 'biffo', 'core'), input.coreTag)
  if (!isCoreRoot(cache)) {
    const { status } = input.runner.run(
      'git',
      ['clone', '--depth', '1', '--branch', input.coreTag, CORE_REPO_URL, cache],
      { cwd: process.cwd(), captureStdout: false },
    )
    if (status !== 0 || !isCoreRoot(cache)) {
      throw new Error(
        `Could not fetch Core (${input.coreTag}) into ${cache} (git exited ${status}). Check out ` +
          `biffo-template yourself and pass --core-root <path>.`,
      )
    }
  }
  return cache
}
