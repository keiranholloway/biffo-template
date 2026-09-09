import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { type GitCommandRunner, resolveUpgradeCommitFiles } from './upgrade-commit-files.js'

/**
 * `resolveUpgradeCommitFiles` is the git-facing half of #1993's fix: it finds
 * the FIRST commit ahead of a base ref, so `core-ownership-guard.ts` can
 * exempt exactly the paths the CLI's own mechanical `biffo core upgrade
 * --apply` commit touched, rather than every path ever pushed to a branch
 * merely named `biffo/core-upgrade-*`.
 *
 * The injected-runner tests pin every "could not tell" path (mirrors the
 * pattern in `template-shipped-paths.test.ts`, #1912). The real-git tests at
 * the bottom reproduce the actual shape of tabsii-platform#1420: a mechanical
 * commit touching a template-owned file, followed by a second, human/agent
 * commit touching an unrelated, user-owned file on the same branch.
 */

function recordingRunner(responses: Record<string, { stdout: string; exitCode: number | null }>): {
  runner: GitCommandRunner
  calls: string[][]
} {
  const calls: string[][] = []
  const runner: GitCommandRunner = async (args) => {
    calls.push(args)
    const key = args[0] ?? ''
    const response = responses[key]
    if (!response) throw new Error(`unexpected git subcommand in test: ${args.join(' ')}`)
    return response
  }
  return { runner, calls }
}

describe('resolveUpgradeCommitFiles — injected runner', () => {
  it('returns the first commit’s own changed files when commits exist ahead of base', async () => {
    const { runner, calls } = recordingRunner({
      'rev-list': { stdout: 'aaa111\nbbb222\n', exitCode: 0 },
      'diff-tree': { stdout: 'services/api/src/api/main.py\n', exitCode: 0 },
    })

    const result = await resolveUpgradeCommitFiles('/repo', 'origin/dev', {}, runner)

    expect(result).toEqual(['services/api/src/api/main.py'])
    expect(calls[0]).toEqual(['rev-list', '--reverse', 'origin/dev..HEAD'])
    // The OLDEST commit (first in the --reverse list) is diffed, not the tip.
    expect(calls[1]).toEqual(['diff-tree', '--no-commit-id', '--name-only', '-r', 'aaa111'])
  })

  it('falls back to the staged files when nothing has landed ahead of base yet (local hook, first commit)', async () => {
    const { runner } = recordingRunner({
      'rev-list': { stdout: '', exitCode: 0 },
    })

    const result = await resolveUpgradeCommitFiles(
      '/repo',
      'origin/dev',
      { stagedFallbackFiles: ['services/api/src/api/main.py'] },
      runner,
    )

    expect(result).toEqual(['services/api/src/api/main.py'])
  })

  it('returns null — not "exempt everything" — when nothing is ahead of base and no fallback was supplied (CI mode)', async () => {
    const { runner } = recordingRunner({
      'rev-list': { stdout: '', exitCode: 0 },
    })

    expect(await resolveUpgradeCommitFiles('/repo', 'origin/main', {}, runner)).toBeNull()
  })

  it('returns null when rev-list itself fails (unresolvable base, shallow history)', async () => {
    const { runner } = recordingRunner({
      'rev-list': { stdout: '', exitCode: 128 },
    })
    expect(await resolveUpgradeCommitFiles('/repo', 'origin/dev', {}, runner)).toBeNull()
  })

  it('returns null when the first commit’s diff-tree fails', async () => {
    const { runner } = recordingRunner({
      'rev-list': { stdout: 'aaa111\n', exitCode: 0 },
      'diff-tree': { stdout: '', exitCode: 1 },
    })
    expect(await resolveUpgradeCommitFiles('/repo', 'origin/dev', {}, runner)).toBeNull()
  })

  it('returns null when the runner throws (e.g. execa timeout rejecting)', async () => {
    const runner: GitCommandRunner = async () => {
      throw new Error('timed out')
    }
    expect(await resolveUpgradeCommitFiles('/repo', 'origin/dev', {}, runner)).toBeNull()
  })
})

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function initRepo(repo: string): void {
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
}

function writeAndCommit(repo: string, path: string, contents: string, message: string): void {
  const full = join(repo, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, contents)
  git(repo, ['add', path])
  git(repo, ['commit', '-q', '-m', message])
}

describe('resolveUpgradeCommitFiles — real git, reproducing tabsii-platform#1420', () => {
  it('scopes to the mechanical commit’s own files, excluding a later commit on the same branch', () => {
    const repo = makeTmpDir('upgrade-commit-files')
    initRepo(repo)
    writeAndCommit(repo, 'README.md', 'init\n', 'chore: init')
    const base = git(repo, ['rev-parse', 'HEAD']).trim()

    // The CLI's own mechanical commit -- template-owned per core-manifest.json.
    writeAndCommit(
      repo,
      'services/api/src/api/main.py',
      'v2\n',
      'chore(core-upgrade): 0.312.0 -> 0.312.5',
    )

    // The second, human+agent commit from the real reproduction -- a
    // user-owned path per core-manifest.json's longest-prefix rule.
    writeAndCommit(
      repo,
      'services/api/src/api/domains/tabsii/tests/test_divergence_declaration.py',
      'revalidated\n',
      'test(tabsii): revalidate divergence declaration',
    )

    return resolveUpgradeCommitFiles(repo, base).then((result) => {
      expect(result).toEqual(['services/api/src/api/main.py'])
      // The second commit's own path must NOT be in the exempted set.
      expect(result).not.toContain(
        'services/api/src/api/domains/tabsii/tests/test_divergence_declaration.py',
      )
    })
  })

  it('treats the staged files as the first commit when nothing has landed on the branch yet', async () => {
    const repo = makeTmpDir('upgrade-commit-files-staged')
    initRepo(repo)
    writeAndCommit(repo, 'README.md', 'init\n', 'chore: init')
    const base = git(repo, ['rev-parse', 'HEAD']).trim()

    // Nothing committed on top of `base` yet -- this simulates the local
    // commit-msg hook firing for the CLI's own about-to-be-made commit.
    const result = await resolveUpgradeCommitFiles(repo, base, {
      stagedFallbackFiles: ['services/api/src/api/main.py'],
    })
    expect(result).toEqual(['services/api/src/api/main.py'])
  })
})
