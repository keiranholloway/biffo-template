import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCoreVersion } from './core-version.js'

/**
 * Materializing template trees at core-version tags for `biffo core upgrade`
 * (ADR-0006). The three-way merge needs the template as it was at the instance's
 * *current* version (the base) and at the *target* version (theirs). Those trees
 * are recoverable from the `core-v<version>` git tags the `Core Version Tag`
 * workflow pushes on every release — so an operator no longer has to hand-supply
 * two template checkouts.
 */

/** The git tag for a core version, e.g. `0.2.0` -> `core-v0.2.0`. */
export function coreTag(version: string): string {
  parseCoreVersion(version) // validate — never build a tag from a non-semver
  return `core-v${version}`
}

/** A materialized tree on disk plus a disposer to remove it. */
export interface MaterializedTree {
  dir: string
  cleanup: () => void
}

/** Injectable git runner so resolution is unit-testable without a real repo. */
export type GitRunner = (args: string[]) => string

const defaultGit: GitRunner = (args) => execFileSync('git', args, { encoding: 'utf8' })

function tagExists(repo: string, tag: string, git: GitRunner): boolean {
  try {
    git(['-C', repo, 'rev-parse', '-q', '--verify', `refs/tags/${tag}`])
    return true
  } catch {
    return false
  }
}

/**
 * Extract the template tree at `core-v<version>` from `repo` into a fresh temp
 * directory, without touching the repo's working tree (uses `git archive`).
 * Fetches tags once if the tag isn't present locally. Throws a clear error if
 * the tag can't be found — an instance can only be upgraded from a version the
 * template actually tagged.
 */
export function materializeTemplateAtTag(
  repo: string,
  version: string,
  git: GitRunner = defaultGit,
): MaterializedTree {
  const tag = coreTag(version)

  if (!tagExists(repo, tag, git)) {
    try {
      git(['-C', repo, 'fetch', '--tags', '--quiet'])
    } catch {
      /* fetch is best-effort; the check below produces the actionable error */
    }
  }
  if (!tagExists(repo, tag, git)) {
    throw new Error(
      `No git tag ${tag} in ${repo}. The template tree at core version ${version} is ` +
        `unavailable, so it can't be used as a merge base. Ensure the tag exists (it is ` +
        `pushed by the Core Version Tag workflow on release), or pass an explicit ` +
        `--from-template / --to-template checkout.`,
    )
  }

  const dir = mkdtempSync(join(tmpdir(), `biffo-core-${version}-`))
  const tarball = join(dir, '.tree.tar')
  try {
    git(['-C', repo, 'archive', '--format=tar', '-o', tarball, tag])
    execFileSync('tar', ['-x', '-f', tarball, '-C', dir])
    rmSync(tarball, { force: true })
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
