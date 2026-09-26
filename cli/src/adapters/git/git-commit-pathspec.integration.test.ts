import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitAdapter } from './index.js'
import { makeTmpDir, removeTmpDir } from '../../test-utils/tmp.js'

/**
 * #2113, proven against a real repository.
 *
 * `GitAdapter.commit` used to run a bare `git commit -m`, which commits the
 * whole index: `plugin install`/`uninstall` (in `--cwd` and in a separate
 * `--frontend-cwd` checkout) swept in anything the operator had already staged
 * for unrelated work. The mocked command tests can only assert which args were
 * passed; whether git then leaves the unrelated file alone is git's behaviour,
 * so it is exercised here.
 */
describe('GitAdapter.commit commits only the given paths (#2113)', () => {
  let repo: string
  const adapter = new GitAdapter()

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  const committedFiles = (): string[] =>
    git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort()

  beforeEach(() => {
    repo = makeTmpDir('biffo-commit-pathspec')
    git('init', '-q', '-b', 'dev')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    mkdirSync(join(repo, 'services', 'widgets'), { recursive: true })
    writeFileSync(join(repo, 'services', 'widgets', 'main.py'), 'x = 1\n')
    writeFileSync(join(repo, 'keep.txt'), 'base\n')
    git('add', '-A')
    git('commit', '-qm', 'base')
  })
  afterEach(() => {
    removeTmpDir(repo)
  })

  it('leaves a pre-staged unrelated file staged and out of the commit', async () => {
    writeFileSync(join(repo, 'unrelated.txt'), 'secret\n')
    git('add', 'unrelated.txt')

    mkdirSync(join(repo, 'modules'), { recursive: true })
    writeFileSync(join(repo, 'modules', 'plugins.ts'), 'export {}\n')
    await adapter.add(repo, ['modules/plugins.ts'])
    await adapter.commit(repo, 'feat(plugins): install widgets', ['modules/plugins.ts'])

    expect(committedFiles()).toEqual(['modules/plugins.ts'])
    // Still the operator's, still staged.
    expect(git('status', '--porcelain')).toBe('A  unrelated.txt')
  })

  it('leaves a pre-staged change to an already-tracked file alone', async () => {
    writeFileSync(join(repo, 'keep.txt'), 'operator edit\n')
    git('add', 'keep.txt')

    writeFileSync(join(repo, 'services', 'widgets', 'main.py'), 'x = 2\n')
    await adapter.add(repo, ['services/widgets'])
    await adapter.commit(repo, 'feat(plugins): upgrade widgets', ['services/widgets'])

    expect(committedFiles()).toEqual(['services/widgets/main.py'])
    expect(git('status', '--porcelain')).toBe('M  keep.txt')
  })

  it('commits a removed directory (the uninstall shape) without the unrelated staged file', async () => {
    writeFileSync(join(repo, 'unrelated.txt'), 'secret\n')
    git('add', 'unrelated.txt')

    rmSync(join(repo, 'services', 'widgets'), { recursive: true })
    await adapter.add(repo, ['services/widgets'])
    await adapter.commit(repo, 'chore(plugins): uninstall widgets', ['services/widgets'])

    expect(committedFiles()).toEqual(['services/widgets/main.py'])
    expect(git('status', '--porcelain')).toBe('A  unrelated.txt')
  })

  it('still makes the very first commit of a fresh repo (init + add . + commit .)', async () => {
    const fresh = makeTmpDir('biffo-commit-pathspec-fresh')
    try {
      const run = (...args: string[]): string =>
        execFileSync('git', args, { cwd: fresh, encoding: 'utf8' }).trim()
      await adapter.init(fresh, 'dev')
      run('config', 'user.email', 'test@example.com')
      run('config', 'user.name', 'Test')
      writeFileSync(join(fresh, 'a.txt'), 'a\n')
      await adapter.add(fresh, ['.'])
      await adapter.commit(fresh, 'feat: scaffold', ['.'])
      expect(run('show', '--name-only', '--format=', 'HEAD')).toBe('a.txt')
    } finally {
      removeTmpDir(fresh)
    }
  })

  it('hasUncommittedChanges(paths) ignores unrelated staged files', async () => {
    writeFileSync(join(repo, 'unrelated.txt'), 'secret\n')
    git('add', 'unrelated.txt')
    await expect(adapter.hasUncommittedChanges(repo)).resolves.toBe(true)
    await expect(adapter.hasUncommittedChanges(repo, ['services/widgets'])).resolves.toBe(false)
  })
})
