/**
 * Local git operations for `biffo plugin install`.
 *
 * Deliberately shells out to the system `git` binary via execa (already a
 * CLI dependency) rather than adding a JS git library — matches the
 * existing pattern of `execSync('gh ...')` calls in the GitHub adapter for
 * operations Octokit doesn't cover.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'

export class GitAdapter {
  /** True if `cwd` is inside a git working tree. */
  async isGitRepo(cwd: string): Promise<boolean> {
    try {
      await execa('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
      return true
    } catch {
      return false
    }
  }

  /**
   * Shallow-clones `repoUrl` into a fresh temp directory and strips its
   * `.git` metadata, so the result is plain files ready to be copied into
   * the target monorepo (which tracks them under its own git history —
   * ADR-0003's "clone into monorepo" distribution model, not a nested repo
   * or submodule).
   */
  async cloneToTemp(repoUrl: string, namePrefix: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), `${namePrefix}-${randomUUID().slice(0, 8)}-`))
    try {
      await execa('git', ['clone', '--depth', '1', repoUrl, dir])
    } catch (err) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`Failed to clone ${repoUrl}: ${(err as Error).message}`)
    }

    const gitDir = join(dir, '.git')
    if (existsSync(gitDir)) rmSync(gitDir, { recursive: true, force: true })

    return dir
  }

  /** Removes a directory created by cloneToTemp. Safe to call more than once. */
  cleanup(dir: string): void {
    rmSync(dir, { recursive: true, force: true })
  }

  async add(cwd: string, paths: string[]): Promise<void> {
    await execa('git', ['add', ...paths], { cwd })
  }

  async commit(cwd: string, message: string): Promise<void> {
    await execa('git', ['commit', '-m', message], { cwd })
  }
}
