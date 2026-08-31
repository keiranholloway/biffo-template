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
import { execa } from '../../lib/exec.js'
import {
  BRANCH_REF_FORMAT,
  parseBranchRefs,
  type BranchRef,
} from '../../lib/upgrade-branch-reaper.js'

export class GitAdapter {
  /** True if `cwd` is inside a git working tree. */
  /**
   * The committer identity git would resolve here, or `null` per unresolved value
   * (#737).
   *
   * `git config --get` exits 1 when a key is unset, which `execa` throws on — so a
   * missing value is caught and reported as `null` rather than as an error. That
   * distinction is the whole point: an unset identity is a condition the caller
   * must act on, not a failure of this lookup.
   *
   * No `cwd` resolves against the process's own configuration, which is what the
   * scaffold's throwaway temp dir inherits.
   */
  async configuredIdentity(cwd?: string): Promise<{ name: string | null; email: string | null }> {
    const read = async (key: string): Promise<string | null> => {
      try {
        const { stdout } = await execa('git', ['config', '--get', key], cwd ? { cwd } : {})
        return stdout.trim() || null
      } catch {
        return null
      }
    }
    return { name: await read('user.name'), email: await read('user.email') }
  }

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
   * handing it to `git clone`. The failure path runs the underlying error
   * through `redactSecrets` before reporting it: `execa` echoes the argv it
   * ran, so the tokenized URL *is* present in that message and interpolating
   * it raw leaked the token into CLI output and CI logs (#1169).
   */
  async cloneToTemp(repoUrl: string, namePrefix: string, token?: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), `${namePrefix}-${randomUUID().slice(0, 8)}-`))
    const cloneUrl = token ? injectToken(repoUrl, token) : repoUrl
    try {
      await execa('git', ['clone', '--depth', '1', cloneUrl, dir])
    } catch (err) {
      rmSync(dir, { recursive: true, force: true })
      throw gitFailure(`Failed to clone ${repoUrl}`, err, [token])
    }

    const gitDir = join(dir, '.git')
    if (existsSync(gitDir)) rmSync(gitDir, { recursive: true, force: true })

    return dir
  }

  /**
   * Like cloneToTemp, but keeps `.git` intact — for `biffo sibling create`'s
   * core-project registration PR (ADR-0007), which needs to branch/commit/
   * push against a repo it doesn't already have checked out locally (unlike
   * `biffo core upgrade`, which edits the user's own already-cloned working
   * tree in place and never clones anything itself). A full (non-shallow)
   * clone, since a shallow clone's single commit can still branch/commit/
   * push fine, but `--depth 1` intentionally omits history callers of this
   * method have no need for.
   */
  async cloneForEditing(repoUrl: string, namePrefix: string, token?: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), `${namePrefix}-${randomUUID().slice(0, 8)}-`))
    const cloneUrl = token ? injectToken(repoUrl, token) : repoUrl
    try {
      await execa('git', ['clone', cloneUrl, dir])
    } catch (err) {
      rmSync(dir, { recursive: true, force: true })
      throw gitFailure(`Failed to clone ${repoUrl}`, err, [token])
    }
    return dir
  }

  /** Removes a directory created by cloneToTemp/cloneForEditing. Safe to call more than once. */
  cleanup(dir: string): void {
    rmSync(dir, { recursive: true, force: true })
  }

  /**
   * `git init` a fresh working tree — for `biffo sibling create` (ADR-0007),
   * which writes the `_skeletons/sibling-template/` skeleton's content into
   * a plain directory (it's read directly off disk, not itself a git
   * remote) and needs to push it as a brand-new GitHub repo's first commit.
   *
   * Sets the initial branch name explicitly (`-b`) rather than relying on
   * the running machine's `init.defaultBranch` git config, which isn't
   * guaranteed to be "dev" (or even consistent between a dev's laptop and
   * a CI runner). Defaults to `dev`, the single integration branch every Biffo
   * repo uses (#559).
   */
  async init(cwd: string, initialBranch = 'dev'): Promise<void> {
    await execa('git', ['init', '-b', initialBranch], { cwd })
  }

  /** Adds a remote. Fails if a remote with this name already exists. */
  async addRemote(cwd: string, name: string, url: string): Promise<void> {
    await execa('git', ['remote', 'add', name, url], { cwd })
  }

  async add(cwd: string, paths: string[]): Promise<void> {
    await execa('git', ['add', ...paths], { cwd })
  }

  async commit(cwd: string, message: string): Promise<void> {
    await execa('git', ['commit', '-m', message], { cwd })
  }

  /** The current branch name (e.g. "dev"). */
  async currentBranch(cwd: string): Promise<string> {
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
    return stdout.trim()
  }

  /** True if the working tree or index has uncommitted changes. */
  async hasUncommittedChanges(cwd: string): Promise<boolean> {
    const { stdout } = await execa('git', ['status', '--porcelain'], { cwd })
    return stdout.trim().length > 0
  }

  /** Best-effort fetch of the tracking remote, so the ahead/behind check below
   * compares against reality rather than a stale local ref (#394). Never throws:
   * offline or a missing remote must not block an upgrade on its own — the
   * ahead/behind check that follows simply works from whatever is local. */
  async fetch(cwd: string, remote = 'origin'): Promise<void> {
    await execa('git', ['fetch', '--quiet', remote], { cwd, reject: false })
  }

  /** HEAD's position relative to its upstream. `hasUpstream` is false when the
   * branch tracks nothing (or HEAD is detached), in which case currency cannot
   * be established and ahead/behind are 0 (#394). */
  async aheadBehind(cwd: string): Promise<{ ahead: number; behind: number; hasUpstream: boolean }> {
    const { stdout, exitCode } = await execa(
      'git',
      ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
      { cwd, reject: false },
    )
    if (exitCode !== 0) return { ahead: 0, behind: 0, hasUpstream: false }
    const [ahead, behind] = stdout
      .trim()
      .split(/\s+/)
      .map((n) => Number.parseInt(n, 10))
    return { ahead: ahead ?? 0, behind: behind ?? 0, hasUpstream: true }
  }

  /** The fetch URL of a remote (default "origin"). */
  async getRemoteUrl(cwd: string, remote = 'origin'): Promise<string> {
    const { stdout } = await execa('git', ['remote', 'get-url', remote], { cwd })
    return stdout.trim()
  }

  /**
   * The commit SHA `HEAD` currently resolves to on `repoUrl`'s default
   * branch, without cloning anything — a single `git ls-remote` round trip.
   * Built for plugin provenance/staleness (#1547): recording or checking a
   * source commit should not need a full clone when the answer is one
   * network call. Returns `null` on any failure (network, auth, a repo that
   * does not exist) rather than throwing — both call sites treat an unknown
   * SHA as an honest "could not determine", never as license to invent one.
   */
  async resolveDefaultBranchSha(repoUrl: string): Promise<string | null> {
    const { stdout, exitCode } = await execa('git', ['ls-remote', '--exit-code', repoUrl, 'HEAD'], {
      reject: false,
    })
    if (exitCode !== 0) return null
    const sha = stdout.split(/\s+/)[0]
    return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null
  }

  /**
   * Prunes remote-tracking refs whose remote branch is gone, so `upstream:track`
   * reports `[gone]` for a merged-and-deleted branch (#758).
   *
   * `fetch()` above deliberately does NOT prune: it exists to make the currency
   * check compare against reality, and pruning is a side effect no caller of it
   * asked for. Reaping genuinely needs it — without a prune, a branch whose
   * remote copy was deleted last month still looks alive — so it is a separate,
   * equally best-effort call.
   */
  async fetchPrune(cwd: string, remote = 'origin'): Promise<void> {
    await execa('git', ['fetch', '--quiet', '--prune', remote], { cwd, reject: false })
  }

  /**
   * Is `cwd` the primary checkout, rather than a linked worktree?
   *
   * The distinction decides whether being off the integration branch is a
   * defect or the mandated state: AGENTS.md §1 requires all work to happen in a
   * worktree on its own branch, while §2 requires the primary to stay on `dev`.
   * Reporting the former as a problem is a false positive in the one place
   * everybody works.
   *
   * A linked worktree's git dir points inside `.git/worktrees/<name>`, while the
   * common dir is the shared `.git`. They are equal only in the primary.
   */
  async isPrimaryWorktree(cwd: string): Promise<boolean> {
    const opts = { cwd, reject: false } as const
    const [dir, common] = await Promise.all([
      execa('git', ['rev-parse', '--absolute-git-dir'], opts),
      execa('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], opts),
    ])
    // Assume primary when it cannot be determined: the checks this gates are
    // the strict ones, and inventing a false positive is the failure to avoid.
    if (dir.exitCode !== 0 || common.exitCode !== 0) return true
    return dir.stdout.trim() === common.stdout.trim()
  }

  /**
   * Worktrees other than the primary, with the branch each is on (#797).
   *
   * `--porcelain` rather than the human format: the latter's alignment and
   * annotations vary, and this has to survive paths with spaces.
   */
  async listWorktrees(cwd: string): Promise<Array<{ path: string; branch: string }>> {
    const { stdout, exitCode } = await execa('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      reject: false,
    })
    if (exitCode !== 0) return []

    const out: Array<{ path: string; branch: string }> = []
    let path = ''
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('branch ')) {
        const branch = line.slice('branch '.length).replace('refs/heads/', '')
        // The first entry is the primary checkout, which `doctor` reports on
        // separately — including it here would double-count it.
        if (out.length > 0 || path !== cwd) out.push({ path, branch })
      }
    }
    return out.filter((w) => w.path !== cwd)
  }

  /** How many commits `branch` is behind `base`; null when it cannot be measured. */
  async countBehind(cwd: string, branch: string, base: string): Promise<number | null> {
    const { stdout, exitCode } = await execa('git', ['rev-list', '--count', `${branch}..${base}`], {
      cwd,
      reject: false,
    })
    if (exitCode !== 0) return null
    const n = Number.parseInt(stdout.trim(), 10)
    return Number.isNaN(n) ? null : n
  }

  /** A file's contents at a ref, or null when it is absent there. */
  async showFileAtRef(cwd: string, ref: string, path: string): Promise<string | null> {
    const { stdout, exitCode } = await execa('git', ['show', `${ref}:${path}`], {
      cwd,
      reject: false,
    })
    return exitCode === 0 ? stdout : null
  }

  /** Every local branch with its upstream and tracking state (#758). */
  async listBranchRefs(cwd: string): Promise<BranchRef[]> {
    const { stdout, exitCode } = await execa(
      'git',
      ['for-each-ref', `--format=${BRANCH_REF_FORMAT}`, 'refs/heads'],
      { cwd, reject: false },
    )
    if (exitCode !== 0) return []
    return parseBranchRefs(stdout)
  }

  /**
   * Force-deletes a local branch, returning whether it went.
   *
   * `-D` rather than `-d` because these branches are squash-merged: their tips
   * are never ancestors of the base, so `-d` refuses every one of them. That is
   * precisely why nobody ever cleaned them up by hand. The safety that `-d`
   * would have provided is supplied instead by the caller, which only ever
   * passes branches whose upstream git reports as gone.
   */
  async deleteBranch(cwd: string, branch: string): Promise<boolean> {
    const { exitCode } = await execa('git', ['branch', '-D', branch], { cwd, reject: false })
    return exitCode === 0
  }

  /**
   * Removes a linked worktree, returning whether it went.
   *
   * Deliberately NOT `--force`: the caller (`doctor --fix`, #1682) only ever
   * reaches this after confirming the worktree is clean, so a plain `remove`
   * should always succeed. If it does not — a lock file, a submodule holding
   * a reference, something this check did not anticipate — failing rather
   * than forcing past it is the point: an unexpected refusal is new
   * information, not an obstacle to blast through on a path that deletes
   * things.
   */
  async removeWorktree(cwd: string, path: string): Promise<boolean> {
    const { exitCode } = await execa('git', ['worktree', 'remove', path], { cwd, reject: false })
    return exitCode === 0
  }

  /**
   * `HEAD`'s commit SHA at `cwd`, or `null` if it cannot be resolved (an
   * unborn branch, a path that is not a git repo). Used by `doctor --fix`
   * (#1810) to prove a worktree's *current* tip — not just its branch name —
   * is what a merged PR actually shipped, before trusting it is safe to
   * delete.
   */
  async headSha(cwd: string): Promise<string | null> {
    const { stdout, exitCode } = await execa('git', ['rev-parse', 'HEAD'], { cwd, reject: false })
    return exitCode === 0 ? stdout.trim() : null
  }

  /**
   * Is `ancestor` reachable from `descendant` (including `ancestor ===
   * descendant`)? Three-valued, not boolean: `git merge-base --is-ancestor`
   * exits `0` for yes, `1` for no, and anything else — most commonly a SHA
   * this repo has never fetched the object for — is a genuine "cannot tell",
   * which callers must treat as unsafe rather than as a "no" (#1810). `cwd`
   * only needs to be *any* worktree of the same clone: the object database is
   * shared, so a commit reachable from one worktree's history is visible from
   * every other.
   */
  async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean | null> {
    const { exitCode } = await execa('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd,
      reject: false,
    })
    if (exitCode === 0) return true
    if (exitCode === 1) return false
    return null
  }

  /** Create and switch to a new branch. Fails if it already exists. */
  async createBranch(cwd: string, branch: string): Promise<void> {
    await execa('git', ['switch', '-c', branch], { cwd })
  }

  /**
   * Switch to an existing branch. Fails if it does not exist, and — deliberately
   * — if the switch would discard uncommitted work: this is the undo half of
   * `createBranch` (#984), so it must never be able to destroy the tree it is
   * putting back.
   */
  async switchBranch(cwd: string, branch: string): Promise<void> {
    await execa('git', ['switch', branch], { cwd })
  }

  /**
   * Push the current HEAD to `branch` on the remote. When `token` is given and
   * the remote is HTTPS, it's embedded in the push URL for auth (SSH/file
   * remotes push with ambient credentials).
   *
   * The failure path reports git's own error, redacted (#1135). It previously
   * discarded it entirely — a defensible-looking choice, since the argv `execa`
   * echoes contains the tokenized URL, but it made **every** push failure in
   * the CLI indistinguishable: a rejected pre-push hook, an unresolvable
   * remote and a bad token all produced the same sentence. That is why #1040
   * ("`core upgrade --apply` aborts at the push step") survived two sessions of
   * diagnosis without its cause ever being established.
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
    } catch (err) {
      throw gitFailure(`Failed to push branch '${branch}' to remote '${remote}'`, err, [opts.token])
    }
    await this.setUpstreamAfterPush(cwd, branch, remote)
  }

  /**
   * Record the pushed branch's upstream, the way `git push -u` would (#758).
   *
   * ## Why not just pass `-u`
   *
   * Because on the token path `target` is a **URL with the token embedded in
   * it**, and `-u` persists whatever it pushed to into `.git/config` as
   * `branch.<name>.remote`. That would write a live credential into the repo's
   * config — permanently, in plain text — which is the precise leak `push`'s own
   * contract promises never to allow. So the upstream is written by hand, always
   * naming the *remote*, never the URL.
   *
   * ## Why it matters at all
   *
   * Without an upstream, a branch this tool created is invisible to **both**
   * standard ways of finding a dead branch, at once:
   *
   *   - `git branch --merged <base>` misses it, because PRs are squash-merged
   *     and the branch tip is never an ancestor of the base;
   *   - `git branch -vv | grep ': gone]'` misses it, because there is no
   *     upstream to be reported gone.
   *
   * `git branch -d` then refuses it too (not an ancestor), leaving only `-D`,
   * which reads as unsafe. The result was 190 accumulated local branches across
   * three repos, with nothing ever looking wrong. One flag's worth of metadata
   * is the difference between that and a one-line cleanup.
   *
   * ## Why the remote-tracking ref is written too
   *
   * Pushing to a *URL* does not update `refs/remotes/<remote>/<branch>`, only
   * pushing via a remote *name* does. Setting the config without that ref would
   * make a freshly-pushed branch report `: gone]` immediately — marking a live
   * branch dead, which is worse than the problem being fixed. The push just
   * succeeded, so the remote is at `HEAD` by construction and the ref can be
   * written offline.
   *
   * ## Why failures here are swallowed
   *
   * The push has already succeeded and the PR is about to be opened. Aborting
   * now would fail an upgrade that actually landed. An upstream is a hygiene
   * affordance, not correctness — the cost of missing it is a leftover branch,
   * which is exactly the state this repo has lived in until now.
   */
  private async setUpstreamAfterPush(cwd: string, branch: string, remote: string): Promise<void> {
    const opts = { cwd, reject: false } as const
    await execa('git', ['update-ref', `refs/remotes/${remote}/${branch}`, 'HEAD'], opts)
    await execa('git', ['config', `branch.${branch}.remote`, remote], opts)
    await execa('git', ['config', `branch.${branch}.merge`, `refs/heads/${branch}`], opts)
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

/** What a redacted secret is replaced with. Exported so tests can assert on it. */
export const REDACTED = '***'

/**
 * Replaces every occurrence of each secret in `text` with `***`, so a failure
 * involving a credential can be **reported** rather than discarded.
 *
 * ## Why this exists
 *
 * Until #1135/#1169 there was no redaction helper anywhere in `cli/src`, so
 * every author handling a credential-carrying failure faced a binary choice
 * between leaking and blinding — and the two call sites in this file picked
 * opposite wrong answers:
 *
 * - `push` discarded the underlying error entirely. Every push failure in the
 *   CLI therefore collapsed to one contentless sentence, which is why #1040's
 *   cause could not be established across two sessions of trying.
 * - `cloneToTemp` / `cloneForEditing` interpolated it verbatim, **leaking the
 *   token** into CLI output and CI logs (#1169) — under a docstring that
 *   asserted the opposite.
 *
 * ## What actually leaks, which is not what it looks like
 *
 * `git` redacts credentials from the messages **it** generates: a failed
 * authentication prints `fatal: Authentication failed for
 * 'https://github.com/owner/repo.git/'`, with no token in it. Reading git's
 * behaviour alone therefore suggests interpolation is safe, and that is
 * precisely the trap the old docstring fell into.
 *
 * The leak is `execa`'s **command echo**. Its error message opens with the full
 * argv it ran:
 *
 * ```
 * Command failed with exit code 128: git clone --depth 1 'https://x-access-token:ghp_REAL@github.com/...'
 * ```
 *
 * so the secret arrives via the command line, not via git's output. That is why
 * redaction has to happen at *this* boundary rather than being delegated to git.
 *
 * ## Notes on the implementation
 *
 * `injectToken` builds the URL with `URL.toString()`, which percent-encodes the
 * password — so a token containing URL-unsafe characters appears in the argv in
 * its **encoded** form and would survive a naive search for the raw value. Both
 * forms are redacted.
 *
 * Uses `split`/`join` rather than a `RegExp` so the secret never has to be
 * regex-escaped; a token containing `.` or `+` would otherwise build a pattern
 * matching far more than itself.
 *
 * Secrets shorter than `MIN_REDACTABLE` are ignored: redacting a 3-character
 * string would punch holes through unrelated words and destroy the diagnostic
 * value this function exists to preserve. Real GitHub tokens are far longer, so
 * this only ever skips test stubs and empty strings.
 */
const MIN_REDACTABLE = 8

export function redactSecrets(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text
  for (const secret of secrets) {
    if (secret === undefined || secret.length < MIN_REDACTABLE) continue
    // The raw value, and the percent-encoded form `URL.toString()` produces.
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      out = out.split(form).join(REDACTED)
    }
  }
  return out
}

/**
 * The message to throw for a failed git invocation that was handed a secret.
 * Always prefer this to either extreme — a bare `catch {}` (undiagnosable) or a
 * raw interpolation (leaky).
 */
function gitFailure(
  summary: string,
  err: unknown,
  secrets: ReadonlyArray<string | undefined>,
): Error {
  const detail = redactSecrets((err as Error).message, secrets)
  return new Error(`${summary}: ${detail}`)
}
