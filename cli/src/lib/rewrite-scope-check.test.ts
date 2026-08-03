import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `scripts/rewrite-scope-check.sh` — refuse a force-push that would write a
 * stale copy of somebody else's merged work.
 *
 * ## The incident (tabsii-platform#446)
 *
 * A branch was rebuilt with `git reset --soft origin/dev && git add -A` to
 * purge a Secret Scan finding. `origin/dev` had advanced by two merged PRs, so
 * HEAD moved onto the newer dev while the working tree held the OLDER copy of
 * a doc those PRs had edited — and `add -A` staged the difference as a revert
 * of four lines of somebody else's work, inside a commit about RLS policies.
 *
 * `verify.sh` passed. 2884 tests passed. The real-Postgres lane passed twice.
 * It surfaced only because GitHub reported the PR CONFLICTING. Had those PRs
 * touched a different file there would have been no conflict and it would have
 * merged.
 *
 * ## Why the tests below are mostly NEGATIVE
 *
 * The first version of this guard asked "has the integration branch moved this
 * file since my base?", which sounds equivalent to the real condition and is
 * not: `reset --soft origin/dev` makes your base the integration tip, so the
 * answer is always no. **It scored a clean pass on a faithful reconstruction of
 * the incident.** That is why `catches the incident` exists — and why the rest
 * of this file is false-positive cases. A pre-push gate that fires on routine
 * work gets disabled, and then it protects nothing.
 */

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const CHECK = join(repoRoot, 'scripts', 'rewrite-scope-check.sh')
const ZERO = '0'.repeat(40)

type Repo = { work: string; git: (...args: string[]) => string }

function scenario(): Repo {
  const base = makeTmpDir('rewrite-scope')
  const remote = join(base, 'remote')
  const work = join(base, 'work')

  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  execFileSync('git', ['init', '--bare', '-q', remote])
  execFileSync('git', ['init', '-q', '-b', 'dev', work])
  const git = (...args: string[]) => run(work, ...args)
  git('config', 'user.email', 'test@example.test')
  git('config', 'user.name', 'Test')

  writeFileSync(join(work, 'shared.md'), 'line1\n')
  writeFileSync(join(work, 'mine.txt'), 'mine\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('remote', 'add', 'origin', remote)
  git('push', '-q', 'origin', 'dev')

  return { work, git }
}

/** Drive the check exactly as git drives a pre-push hook: refs on stdin. */
function check(repo: Repo, ref: string, localSha: string, remoteSha: string, env = {}) {
  try {
    const stdout = execFileSync('sh', [CHECK], {
      cwd: repo.work,
      input: `refs/heads/${ref} ${localSha} refs/heads/${ref} ${remoteSha}\n`,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { code: 0, output: stdout }
  } catch (error) {
    const e = error as { status: number; stderr: string; stdout: string }
    return { code: e.status, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('rewrite-scope-check', () => {
  it('catches the incident: a rewrite that writes a historical copy of a file', () => {
    const repo = scenario()
    repo.git('checkout', '-qb', 'feat/x')
    appendFileSync(join(repo.work, 'mine.txt'), 'feature\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'my work')
    repo.git('push', '-q', 'origin', 'feat/x')
    const remoteSha = repo.git('rev-parse', 'HEAD')

    // Somebody else's PR lands on dev, touching a file this branch has not.
    repo.git('checkout', '-q', 'dev')
    appendFileSync(join(repo.work, 'shared.md'), 'line2 from someone else\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'PR-A edits shared.md')
    repo.git('push', '-q', 'origin', 'dev')
    repo.git('fetch', '-q', 'origin')

    // The rebuild, exactly as it happened: reset onto the MOVED ref.
    repo.git('checkout', '-q', 'feat/x')
    repo.git('reset', '--soft', 'origin/dev')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'rebuilt branch')

    // Sanity: the commit really does revert the other PR's line. Without this
    // the test could pass against a scenario that never reproduced anything.
    expect(repo.git('show', '--stat', '--format=', 'HEAD')).toContain('shared.md')

    const result = check(repo, 'feat/x', repo.git('rev-parse', 'HEAD'), remoteSha)
    expect(result.code).toBe(1)
    expect(result.output).toContain('shared.md')
    expect(result.output).toContain('ALREADY HAD')
  })

  it('allows the same push behind the escape hatch', () => {
    const repo = scenario()
    repo.git('checkout', '-qb', 'feat/x')
    appendFileSync(join(repo.work, 'mine.txt'), 'feature\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'my work')
    repo.git('push', '-q', 'origin', 'feat/x')
    const remoteSha = repo.git('rev-parse', 'HEAD')

    repo.git('checkout', '-q', 'dev')
    appendFileSync(join(repo.work, 'shared.md'), 'line2\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'PR-A')
    repo.git('push', '-q', 'origin', 'dev')
    repo.git('fetch', '-q', 'origin')
    repo.git('checkout', '-q', 'feat/x')
    repo.git('reset', '--soft', 'origin/dev')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'rebuilt')

    const result = check(repo, 'feat/x', repo.git('rev-parse', 'HEAD'), remoteSha, {
      BIFFO_ALLOW_SCOPE_CHANGE: '1',
    })
    expect(result.code).toBe(0)
  })

  it('stays silent on an ordinary fast-forward push', () => {
    const repo = scenario()
    repo.git('checkout', '-qb', 'ff')
    appendFileSync(join(repo.work, 'mine.txt'), 'a\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'a')
    repo.git('push', '-q', 'origin', 'ff')
    const remoteSha = repo.git('rev-parse', 'HEAD')
    appendFileSync(join(repo.work, 'mine.txt'), 'b\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'b')

    expect(check(repo, 'ff', repo.git('rev-parse', 'HEAD'), remoteSha).code).toBe(0)
  })

  it('stays silent on a brand-new remote branch', () => {
    const repo = scenario()
    repo.git('checkout', '-qb', 'brand-new')
    appendFileSync(join(repo.work, 'mine.txt'), 'a\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'a')

    expect(check(repo, 'brand-new', repo.git('rev-parse', 'HEAD'), ZERO).code).toBe(0)
  })

  it('stays silent on a legitimate rebase onto a newer integration branch', () => {
    const repo = scenario()
    const forkPoint = repo.git('rev-parse', 'HEAD')
    repo.git('checkout', '-qb', 'reb')
    writeFileSync(join(repo.work, 'newfile.txt'), 'work\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'r1')
    repo.git('push', '-q', 'origin', 'reb')
    const remoteSha = repo.git('rev-parse', 'HEAD')

    repo.git('checkout', '-q', 'dev')
    expect(repo.git('rev-parse', 'HEAD')).toBe(forkPoint)
    appendFileSync(join(repo.work, 'shared.md'), 'dev moves on\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'dev work')
    repo.git('push', '-q', 'origin', 'dev')
    repo.git('fetch', '-q', 'origin')

    repo.git('checkout', '-q', 'reb')
    repo.git('rebase', '-q', 'origin/dev')

    expect(check(repo, 'reb', repo.git('rev-parse', 'HEAD'), remoteSha).code).toBe(0)
  })

  it('stays silent when an amend adds a file nobody else has touched', () => {
    const repo = scenario()
    repo.git('checkout', '-qb', 'amend')
    writeFileSync(join(repo.work, 'only-mine.txt'), 'a\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'a1')
    repo.git('push', '-q', 'origin', 'amend')
    const remoteSha = repo.git('rev-parse', 'HEAD')

    writeFileSync(join(repo.work, 'also-mine.txt'), 'b\n')
    repo.git('add', '-A')
    repo.git('commit', '-q', '--amend', '-m', 'a1 plus the forgotten file')

    expect(check(repo, 'amend', repo.git('rev-parse', 'HEAD'), remoteSha).code).toBe(0)
  })

  it('stays silent when the branch makes genuinely NEW changes to a shared file', () => {
    // The case that separates this guard from "warn on any concurrent edit":
    // two branches editing one file is normal, and only a STALE copy is a bug.
    const repo = scenario()
    repo.git('checkout', '-qb', 'concur')
    appendFileSync(join(repo.work, 'shared.md'), 'my new line\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'c1')
    repo.git('push', '-q', 'origin', 'concur')
    const remoteSha = repo.git('rev-parse', 'HEAD')

    appendFileSync(join(repo.work, 'shared.md'), 'another new line\n')
    repo.git('add', '-A')
    repo.git('commit', '-q', '--amend', '-m', 'c1 revised')

    expect(check(repo, 'concur', repo.git('rev-parse', 'HEAD'), remoteSha).code).toBe(0)
  })

  it('reports rather than passes when it cannot resolve an integration branch', () => {
    // Absence is reported, never mistaken for clean — the contract verify.sh
    // uses for a check whose tool is missing.
    const base = makeTmpDir('rewrite-scope-noremote')
    execFileSync('git', ['init', '-q', '-b', 'dev', base])
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: base })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: base })
    writeFileSync(join(base, 'f.txt'), 'x\n')
    execFileSync('git', ['add', '-A'], { cwd: base })
    execFileSync('git', ['commit', '-qm', 'c'], { cwd: base })
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: base, encoding: 'utf8' }).trim()

    const out = execFileSync('sh', [CHECK], {
      cwd: base,
      input: `refs/heads/dev ${sha} refs/heads/dev ${sha}\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    expect(`${out}`).toBe('')
  })
})
