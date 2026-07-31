import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitTrackedFiles } from './git-tracked-files.js'

function git(repo: string, args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
}

function write(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

describe('gitTrackedFiles', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'biffo-tracked-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists tracked files and omits gitignored ones', () => {
    git(dir, ['init', '--quiet'])
    write(dir, '.gitignore', '*.tsbuildinfo\n.terraform.lock.hcl\n')
    write(dir, 'services/api/main.py', 'x')
    write(dir, 'apps/portal/tsconfig.tsbuildinfo', 'BUILD ARTIFACT')
    write(dir, 'modules/cloud/aws/database/.terraform.lock.hcl', 'LOCK')
    git(dir, ['add', '-A'])

    const tracked = gitTrackedFiles(dir)
    expect(tracked).not.toBeNull()
    expect([...(tracked as Set<string>)].sort()).toEqual(['.gitignore', 'services/api/main.py'])
  })

  it('omits an untracked file even when nothing ignores it', () => {
    git(dir, ['init', '--quiet'])
    write(dir, 'services/api/main.py', 'x')
    git(dir, ['add', '-A'])
    write(dir, 'services/api/scratch.py', 'not added')

    expect(gitTrackedFiles(dir)?.has('services/api/scratch.py')).toBe(false)
  })

  it('returns null outside a git worktree, so callers fall back to the filesystem', () => {
    // A `git archive <tag>` extraction looks exactly like this: a plain
    // directory holding only tracked content, with nothing to filter.
    write(dir, 'services/api/main.py', 'x')
    expect(gitTrackedFiles(dir)).toBeNull()
  })

  it('returns null for a subdirectory of a repo rather than filtering it to nothing', () => {
    git(dir, ['init', '--quiet'])
    write(dir, 'a.txt', 'x')
    git(dir, ['add', '-A'])
    const sub = join(dir, 'extracted')
    mkdirSync(sub)
    write(sub, 'services/api/main.py', 'x')
    // `git ls-files` from here reports nothing; answering with an empty set
    // would filter the whole tree away and read as "the core vanished".
    expect(gitTrackedFiles(sub)).toBeNull()
  })

  it('returns null for an empty index rather than an empty set', () => {
    git(dir, ['init', '--quiet'])
    write(dir, 'services/api/main.py', 'x')
    expect(gitTrackedFiles(dir)).toBeNull()
  })

  it('returns null when git is unavailable', () => {
    const failing = (): string => {
      throw new Error('git: command not found')
    }
    expect(gitTrackedFiles(dir, failing)).toBeNull()
  })
})
