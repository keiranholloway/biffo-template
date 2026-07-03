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
   *
   * `token`, when given, authenticates the clone against a private repo by
   * embedding it in the URL's userinfo (`https://x-access-token:<token>@...`
   * — the standard scheme for a GitHub PAT/App token over HTTPS) before
   * handing it to `git clone`. The *rewritten* URL is only ever passed to
   * `execa`, never logged or included in a thrown error message — errors
   * reference the original `repoUrl` so a token can't leak into CLI output
   * or a crash report.
   */
  async cloneToTemp(repoUrl: string, namePrefix: string, token?: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), `${namePrefix}-${randomUUID().slice(0, 8)}-`))
    const cloneUrl = token ? injectToken(repoUrl, token) : repoUrl
    try {
      await execa('git', ['clone', '--depth', '1', cloneUrl, dir])
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

  /** The current branch name (e.g. "main"). */
  async currentBranch(cwd: string): Promise<string> {
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
    return stdout.trim()
  }

  /** True if the working tree or index has uncommitted changes. */
  async hasUncommittedChanges(cwd: string): Promise<boolean> {
    const { stdout } = await execa('git', ['status', '--porcelain'], { cwd })
    return stdout.trim().length > 0
  }

  /** The fetch URL of a remote (default "origin"). */
  async getRemoteUrl(cwd: string, remote = 'origin'): Promise<string> {
    const { stdout } = await execa('git', ['remote', 'get-url', remote], { cwd })
    return stdout.trim()
  }

  /** Create and switch to a new branch. Fails if it already exists. */
  async createBranch(cwd: string, branch: string): Promise<void> {
    await execa('git', ['switch', '-c', branch], { cwd })
  }

  /**
   * Push the current HEAD to `branch` on the remote. When `token` is given and
   * the remote is HTTPS, it's embedded in the push URL for auth (SSH/file
   * remotes push with ambient credentials). The authenticated URL is never
   * logged or included in a thrown error — a push failure references only the
   * remote name, so a token can't leak into CLI output or a crash report.
   */
  async push(
    cwd: string,
    branch: string,
    opts: { remote?: string; token?: string } = {},
  ): Promise<void> {
    const remote = opts.remote ?? 'origin'
    let target = remote
    if (opts.token) {
      const url = await this.getRemoteUrl(cwd, remote)
      const authed = injectToken(url, opts.token)
      if (authed !== url) target = authed // HTTPS remote — push to the tokenized URL
    }
    try {
      await execa('git', ['push', target, `HEAD:refs/heads/${branch}`], { cwd })
    } catch {
      // Deliberately do NOT include the underlying error (it can contain the
      // tokenized URL). Reference only the remote name.
      throw new Error(`Failed to push branch '${branch}' to remote '${remote}'.`)
    }
  }
}

/**
 * Rewrites an `https://` git URL to embed `token` as HTTP Basic userinfo
 * (`x-access-token:<token>@host`). Non-`https` URLs (`git@host:...` SSH
 * form, `file://...` used by this codebase's own integration tests) are
 * returned unchanged — a token only makes sense for HTTPS auth, and
 * rewriting an SSH/file URL would silently produce something `git clone`
 * can't use.
 */
function injectToken(repoUrl: string, token: string): string {
  let parsed: URL
  try {
    parsed = new URL(repoUrl)
  } catch {
    return repoUrl
  }
  if (parsed.protocol !== 'https:') return repoUrl

  parsed.username = 'x-access-token'
  parsed.password = token
  return parsed.toString()
}
