import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

vi.mock('../lib/template-shipped-paths.js', () => ({
  fetchTemplateShippedPaths: vi.fn().mockResolvedValue(null),
}))

const { runOwnershipCheck } = await import('./check-core-ownership.js')

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  )

function put(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), content)
}

// tabsii-platform#1648 (2026-10-10): the fleet's rebaser merged origin/dev into a
// PR branch after core-staleness PRs had landed template-owned files on dev, and
// the commit-msg hook refused the merge as an edit of those files.
describe('ownership guard --staged: a merge commit', () => {
  let work: string
  let cwd: string
  let msgFile: string
  const env = { ...process.env }
  let errors: string[]
  let logs: string[]

  beforeEach(() => {
    cwd = process.cwd()
    work = makeTmpDir('own-merge')
    git(work, 'init', '-b', 'dev')
    copyFileSync(join(repoRoot, 'core-manifest.json'), join(work, 'core-manifest.json'))
    put(work, 'biffo.core.json', '{"version":"0.396.1"}')
    put(work, 'scripts/core.sh', '#!/bin/sh\n# core v1\n')
    put(work, 'scripts/old-core.sh', '#!/bin/sh\n# retired upstream\n')
    put(work, 'infra/environments/dev/app.instance.tf', '# v1\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-m', 'init')
    // The PR branch, cut before the core upgrade, edits only user-owned paths.
    git(work, 'switch', '-c', 'fleet/issue-1551')
    put(work, 'infra/environments/dev/app.instance.tf', '# feature\n')
    git(work, 'commit', '-am', 'feat: user-owned change')
    // dev then takes a core upgrade: a template-owned file changes, one is deleted.
    git(work, 'switch', 'dev')
    put(work, 'scripts/core.sh', '#!/bin/sh\n# core v2\n')
    git(work, 'rm', '-q', 'scripts/old-core.sh')
    git(work, 'commit', '-am', 'chore(core): upgrade template core 0.396.1 -> 0.404.0')
    git(work, 'switch', 'fleet/issue-1551')
    msgFile = join(makeTmpDir('own-merge-msg'), 'COMMIT_EDITMSG')
    writeFileSync(msgFile, "Merge branch 'dev' into fleet/issue-1551\n")
    process.chdir(work)
    delete process.env['GITHUB_HEAD_REF']
    delete process.env['GITHUB_REF_NAME']
    delete process.env['GITHUB_BASE_REF']
    errors = []
    logs = []
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => void logs.push(String(m)))
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errors.push(String(m)))
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`)
    }) as never)
  })
  afterEach(() => {
    process.chdir(cwd)
    process.env = { ...env }
    vi.restoreAllMocks()
    rmSync(work, { recursive: true, force: true })
  })

  it('allows template-owned files the merge brought in from dev, including a deletion', async () => {
    git(work, 'merge', '--no-ff', '--no-commit', 'dev')
    await runOwnershipCheck(['--staged', msgFile])
    expect(errors.filter((e) => e.includes('template-owned'))).toEqual([])
    expect(logs.join('\n')).toContain('merge in progress: 2 staged path(s)')
  })

  it('refuses a merge whose resolution edits a template-owned file', async () => {
    git(work, 'merge', '--no-ff', '--no-commit', 'dev')
    put(work, 'scripts/core.sh', '#!/bin/sh\n# hand-edited during the merge\n')
    git(work, 'add', 'scripts/core.sh')
    await expect(runOwnershipCheck(['--staged', msgFile])).rejects.toThrow('exit:1')
    const out = errors.join('\n')
    expect(out).toContain('scripts/core.sh')
    expect(out).not.toContain('scripts/old-core.sh')
  })

  it('allows a conflict resolved by taking the merged-in side, refuses one that matches neither', async () => {
    put(work, 'scripts/core.sh', '#!/bin/sh\n# branch edit\n')
    git(work, 'commit', '-q', '-am', 'fix: branch edit', '--no-verify')
    expect(() => git(work, 'merge', '--no-ff', '--no-commit', 'dev')).toThrow()
    git(work, 'checkout', '--theirs', 'scripts/core.sh')
    git(work, 'add', 'scripts/core.sh')
    await runOwnershipCheck(['--staged', msgFile])
    expect(errors.filter((e) => e.includes('template-owned'))).toEqual([])

    put(work, 'scripts/core.sh', '#!/bin/sh\n# resolved to something new\n')
    git(work, 'add', 'scripts/core.sh')
    errors.length = 0
    await expect(runOwnershipCheck(['--staged', msgFile])).rejects.toThrow('exit:1')
    expect(errors.join('\n')).toContain('scripts/core.sh')
  })

  it('still refuses an ordinary (non-merge) commit that edits a template-owned file', async () => {
    put(work, 'scripts/core.sh', '#!/bin/sh\n# direct edit\n')
    git(work, 'add', 'scripts/core.sh')
    await expect(runOwnershipCheck(['--staged', msgFile])).rejects.toThrow('exit:1')
    expect(errors.join('\n')).toContain('scripts/core.sh')
    expect(logs.join('\n')).not.toContain('merge in progress')
  })
})
