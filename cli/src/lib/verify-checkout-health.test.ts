/**
 * `verify.sh --checkout-health` -- is the tree a command is about to trust
 * stale or dirty in the ONE place that matters: the PRIMARY checkout? (#1196)
 *
 * AGENTS.md SS1/SS2 already say the primary must stay on the integration
 * branch, no more than a `git fetch` behind, and that real work happens in
 * worktrees instead -- but nothing checked it, and an agent auditing
 * `tabsii-crm`'s `auth.ts` built a whole, internally consistent, WRONG
 * analysis from a primary checkout that was 16 commits behind `origin/dev`,
 * 1 ahead, and dirty. The agent's reasoning was sound; its input was not, and
 * nothing said so.
 *
 * `--checkout-health` answers that question directly and FAILS CLOSED:
 * exit 0 healthy, 1 stale/dirty, 2 "cannot tell" (never a pass, matching the
 * `wait-for-checks.sh`/`branch-health.sh` convention). It deliberately does
 * NOT fire for a worktree, a detached HEAD, or a checkout parked on some
 * other branch -- a worktree diverging from `origin/dev` mid-task is normal,
 * not the danger case this exists for.
 *
 * These tests build real local git remotes (`git init --bare`) rather than
 * mocking git, because the whole point under test is ahead/behind/dirty
 * arithmetic against a real `origin` -- a mock would just re-assert whatever
 * the mock was told to return.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = join(repoRoot, 'scripts/verify.sh')

interface Run {
  stdout: string
  status: number
}

function runCheckoutHealth(cwd: string): Run {
  try {
    const stdout = String(
      execFileSync('sh', [SCRIPT, '--checkout-health'], {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 15_000,
      }),
    )
    return { stdout, status: 0 }
  } catch (err) {
    const e = err as { stdout?: string; status?: number }
    return { stdout: String(e.stdout ?? ''), status: e.status ?? -1 }
  }
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd })
}

let root: string
let originDir: string
let localDir: string

/** origin (bare, `dev` default) + a `local` clone on `dev`, both fully in sync. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'checkout-health-'))
  originDir = join(root, 'origin.git')
  git(['init', '-q', '--bare', '-b', 'dev', originDir], root)

  const seedDir = join(root, 'seed')
  git(['clone', '-q', originDir, seedDir], root)
  writeFileSync(join(seedDir, 'f.txt'), 'v1\n')
  git(['add', 'f.txt'], seedDir)
  git(['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '-m', 'init'], seedDir)
  git(['push', '-q', 'origin', 'dev'], seedDir)

  localDir = join(root, 'local')
  git(['clone', '-q', originDir, localDir], root)
  git(['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'checkout', '-q', 'dev'], localDir)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('verify.sh --checkout-health: the primary checkout on the integration branch', () => {
  it('passes clean: healthy, exit 0', () => {
    // The precise `checkout-health:` prefix, not a bare 'OK' -- a plain 'OK'
    // substring is not distinctive: the pre-fix script (no `--checkout-health`
    // handling at all) ignores the unrecognised flag and runs the WHOLE
    // ordinary gate instead, which prints its own unrelated "OK   gitleaks"/
    // "OK   lint" lines and would satisfy a loose assertion for the wrong
    // reason. Caught by the fail-first rehearsal, not by inspection.
    const run = runCheckoutHealth(localDir)
    expect(run.stdout).toContain('checkout-health: OK')
    expect(run.status).toBe(0)
  })

  it('fails closed when BEHIND origin -- the exact shape of the reported incident', () => {
    // Advance origin without pulling into local: this is the tabsii-crm
    // shape, a primary that never caught up.
    const seedDir = join(root, 'seed')
    writeFileSync(join(seedDir, 'f.txt'), 'v2\n')
    git(['add', 'f.txt'], seedDir)
    git(['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '-m', 'second'], seedDir)
    git(['push', '-q', 'origin', 'dev'], seedDir)

    const run = runCheckoutHealth(localDir)
    expect(run.stdout).toContain('STALE')
    expect(run.stdout).toContain('behind')
    expect(run.status).toBe(1)
  })

  it('fails closed when DIRTY, even with no commits behind', () => {
    writeFileSync(join(localDir, 'f.txt'), 'uncommitted edit\n')
    const run = runCheckoutHealth(localDir)
    expect(run.stdout).toContain('STALE')
    expect(run.stdout).toContain('dirty')
    expect(run.status).toBe(1)
  })

  it('fails closed when AHEAD -- unpushed commits sitting directly on the primary', () => {
    // AGENTS.md SS1 forbids committing on the primary at all; this is that
    // violation compounding into the same "cannot be trusted" state as being
    // behind, which is why it is folded into the same STALE verdict rather
    // than treated as separately fine.
    writeFileSync(join(localDir, 'f.txt'), 'v3\n')
    git(['add', 'f.txt'], localDir)
    git(
      ['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '-m', 'local-only'],
      localDir,
    )

    const run = runCheckoutHealth(localDir)
    expect(run.stdout).toContain('STALE')
    expect(run.stdout).toContain('ahead')
    expect(run.status).toBe(1)
  })

  it('reports every applicable dimension together, not just the first one found', () => {
    writeFileSync(join(localDir, 'f.txt'), 'dirty AND behind\n')
    const seedDir = join(root, 'seed')
    execFileSync('git', ['checkout', '-q', 'dev'], { cwd: join(root, 'seed') })
    writeFileSync(join(seedDir, 'other.txt'), 'v2\n')
    git(['add', 'other.txt'], seedDir)
    git(['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '-m', 'second'], seedDir)
    git(['push', '-q', 'origin', 'dev'], seedDir)

    const run = runCheckoutHealth(localDir)
    expect(run.stdout).toContain('behind')
    expect(run.stdout).toContain('dirty')
  })
})

describe('verify.sh --checkout-health: out of scope, reported as n/a rather than silently healthy', () => {
  it('never evaluates a linked worktree, even one behind origin/dev', () => {
    const seedDir = join(root, 'seed')
    writeFileSync(join(seedDir, 'f.txt'), 'v2\n')
    git(['add', 'f.txt'], seedDir)
    git(['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '-m', 'second'], seedDir)
    git(['push', '-q', 'origin', 'dev'], seedDir)

    const wtDir = join(root, 'local-wt')
    git(['worktree', 'add', '-q', '-b', 'wt-branch', wtDir, 'dev'], localDir)
    try {
      const run = runCheckoutHealth(wtDir)
      expect(run.stdout).toContain('checkout-health: n/a')
      expect(run.status).toBe(0)
    } finally {
      git(['worktree', 'remove', wtDir, '--force'], localDir)
    }
  })

  it('does not evaluate a checkout parked on a branch other than the integration branch', () => {
    git(['checkout', '-q', '-b', 'feature/unrelated'], localDir)
    const run = runCheckoutHealth(localDir)
    expect(run.stdout).toContain('checkout-health: n/a')
    expect(run.status).toBe(0)
  })

  it('does not evaluate a detached HEAD', () => {
    git(['checkout', '-q', '--detach', 'dev'], localDir)
    const run = runCheckoutHealth(localDir)
    expect(run.stdout).toContain('checkout-health: n/a')
    expect(run.status).toBe(0)
  })
})

describe('verify.sh --checkout-health: cannot tell is never a pass', () => {
  it('exits 2, not 0, when there is no origin remote to compare against at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'checkout-health-noorigin-'))
    try {
      git(['init', '-q', '-b', 'dev'], dir)
      writeFileSync(join(dir, 'f.txt'), 'x\n')
      git(['add', 'f.txt'], dir)
      git(['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '-m', 'init'], dir)

      const run = runCheckoutHealth(dir)
      expect(run.stdout).toContain('checkout-health: CANNOT TELL')
      expect(run.status).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to a cached origin/dev when the remote cannot be reached, rather than failing closed unnecessarily', () => {
    // A fetch may be the only way to know staleness, but a machine that
    // fetched recently and has since gone offline still HAS the evidence --
    // the design brief for #1196 says explicitly not to hard-fail an offline
    // machine when it does not need to. Point origin at a path that no
    // longer exists; the cached remote-tracking ref from the initial clone
    // is still there.
    git(['remote', 'set-url', 'origin', join(root, 'this-path-does-not-exist.git')], localDir)
    const run = runCheckoutHealth(localDir)
    // Healthy (in sync with the last-known origin/dev) rather than unknown.
    expect(run.stdout).toContain('checkout-health: OK')
    expect(run.status).toBe(0)
  })
})
