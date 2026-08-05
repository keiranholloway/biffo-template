import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `scripts/pgtest-diff-check.sh` — does the push about to happen touch
 * `db/imports/**` or a `*_pg.py` module?
 *
 * `.githooks/pre-push` runs this with the same ref-list-on-stdin contract as
 * `rewrite-scope-check.sh` (see that file's test for the pattern this copies),
 * and uses the answer to decide whether verify.sh's `pg-test` amber warning
 * should escalate into a block (tabsii-platform#656).
 */

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const CHECK = join(repoRoot, 'scripts', 'pgtest-diff-check.sh')
const ZERO = '0'.repeat(40)

type Repo = { work: string; git: (...args: string[]) => string }

function scenario(): Repo {
  const base = makeTmpDir('pgtest-diff-check')
  const remote = join(base, 'remote')
  const work = join(base, 'work')

  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  execFileSync('git', ['init', '--bare', '-q', remote])
  execFileSync('git', ['init', '-q', '-b', 'dev', work])
  const git = (...args: string[]) => run(work, ...args)
  git('config', 'user.email', 'test@example.test')
  git('config', 'user.name', 'Test')

  writeFileSync(join(work, 'README.md'), 'base\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('remote', 'add', 'origin', remote)
  git('push', '-q', 'origin', 'dev')

  return { work, git }
}

/** Drive the check exactly as the hook drives it: refs on stdin. */
function check(repo: Repo, ref: string, localSha: string, remoteSha: string) {
  try {
    const stdout = execFileSync('sh', [CHECK], {
      cwd: repo.work,
      input: `refs/heads/${ref} ${localSha} refs/heads/${ref} ${remoteSha}\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { code: 0, output: stdout }
  } catch (error) {
    const e = error as { status: number; stderr: string; stdout: string }
    return { code: e.status, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

function writeDeep(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

describe('pgtest-diff-check', () => {
  it('reports relevant when the push touches db/imports/**', () => {
    const repo = scenario()
    repo.git('checkout', '-qb', 'feat/ddl')
    writeDeep(join(repo.work, 'db/imports/tenants/001_init.sql'), 'CREATE TABLE t();\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'add DDL')

    const result = check(repo, 'feat/ddl', repo.git('rev-parse', 'HEAD'), ZERO)
    expect(result.code).toBe(0)
  })

  it('reports relevant when the push touches a *_pg.py module', () => {
    const repo = scenario()
    repo.git('checkout', '-qb', 'feat/pgtest')
    writeDeep(join(repo.work, 'services/api/tests/test_rls_pg.py'), 'def test_x(): pass\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'add pg test')

    const result = check(repo, 'feat/pgtest', repo.git('rev-parse', 'HEAD'), ZERO)
    expect(result.code).toBe(0)
  })

  it('reports NOT relevant for an unrelated (frontend) diff', () => {
    const repo = scenario()
    repo.git('checkout', '-qb', 'feat/frontend')
    writeDeep(
      join(repo.work, 'apps/portal/src/app/page.tsx'),
      'export default function Page() {}\n',
    )
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'tweak portal')

    const result = check(repo, 'feat/frontend', repo.git('rev-parse', 'HEAD'), ZERO)
    expect(result.code).toBe(1)
  })

  it('compares against the remote tip, not the whole branch history, on an update', () => {
    const repo = scenario()
    repo.git('checkout', '-qb', 'feat/incremental')
    writeDeep(join(repo.work, 'db/imports/tenants/001_init.sql'), 'CREATE TABLE t();\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'add DDL')
    repo.git('push', '-q', 'origin', 'feat/incremental')
    const remoteSha = repo.git('rev-parse', 'HEAD')

    // A second, unrelated commit on top -- only THIS should be in scope now.
    writeDeep(
      join(repo.work, 'apps/portal/src/app/page.tsx'),
      'export default function Page() {}\n',
    )
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'tweak portal')

    const result = check(repo, 'feat/incremental', repo.git('rev-parse', 'HEAD'), remoteSha)
    expect(result.code).toBe(1)
  })

  it('stays silent (branch deletion) when local sha is all-zero', () => {
    const repo = scenario()
    const result = check(repo, 'gone', ZERO, repo.git('rev-parse', 'HEAD'))
    expect(result.code).toBe(1)
  })

  it('exits 2 (cannot tell) rather than 0 or 1 with no integration branch and an unreachable remote sha', () => {
    const base = makeTmpDir('pgtest-diff-check-noremote2')
    execFileSync('git', ['init', '-q', '-b', 'dev', base])
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: base })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: base })
    writeFileSync(join(base, 'f.txt'), 'x\n')
    execFileSync('git', ['add', '-A'], { cwd: base })
    execFileSync('git', ['commit', '-qm', 'c'], { cwd: base })
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: base, encoding: 'utf8' }).trim()
    const fakeRemote = '1'.repeat(40)

    let code = 0
    try {
      execFileSync('sh', [CHECK], {
        cwd: base,
        input: `refs/heads/dev ${sha} refs/heads/dev ${fakeRemote}\n`,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      code = (error as { status: number }).status
    }
    expect(code).toBe(2)
  })

  it('exits 2 (cannot tell) when there is no ref list on stdin at all', () => {
    const repo = scenario()
    let code = 0
    try {
      execFileSync('sh', [CHECK], {
        cwd: repo.work,
        input: '',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      code = (error as { status: number }).status
    }
    expect(code).toBe(2)
  })

  it('finds the relevant path anywhere in a multi-commit push', () => {
    const repo = scenario()
    repo.git('checkout', '-qb', 'feat/mixed')
    writeDeep(join(repo.work, 'apps/portal/src/app/page.tsx'), 'a\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'frontend change')
    writeDeep(join(repo.work, 'db/imports/tenants/002_rls.sql'), 'CREATE POLICY p ON t;\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'RLS policy')
    appendFileSync(join(repo.work, 'apps/portal/src/app/page.tsx'), 'b\n')
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'more frontend')

    const result = check(repo, 'feat/mixed', repo.git('rev-parse', 'HEAD'), ZERO)
    expect(result.code).toBe(0)
  })
})
