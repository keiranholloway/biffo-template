import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

// The runner's CI mode fetches the template's tree over the network; "could not
// tell" is the documented offline fallback and is all this test needs.
vi.mock('../lib/template-shipped-paths.js', () => ({
  fetchTemplateShippedPaths: vi.fn().mockResolvedValue(null),
}))

const { runOwnershipCheck } = await import('./check-core-ownership.js')

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const CLI_SUBJECT = 'chore(core): upgrade template core 0.371.0 -> 0.384.0'

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

describe('ownership guard: the CLI upgrade commit on a fleet branch', () => {
  let work: string
  let cwd: string
  const env = { ...process.env }
  let errors: string[]
  let logs: string[]

  beforeEach(() => {
    cwd = process.cwd()
    const origin = makeTmpDir('own-origin')
    work = makeTmpDir('own-work')
    git(origin, 'init', '--bare', '-b', 'dev')
    git(work, 'init', '-b', 'dev')
    git(work, 'remote', 'add', 'origin', origin)
    copyFileSync(join(repoRoot, 'core-manifest.json'), join(work, 'core-manifest.json'))
    put(work, 'biffo.core.json', '{"version":"0.371.0"}')
    put(work, 'package.json', '{}')
    git(work, 'add', '-A')
    git(work, 'commit', '-m', 'init')
    git(work, 'push', '-q', 'origin', 'dev')
    process.chdir(work)
    process.env['GITHUB_BASE_REF'] = 'dev'
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
  })

  function commit(files: Record<string, string>, subject: string): void {
    for (const [rel, body] of Object.entries(files)) put(work, rel, body)
    git(work, 'add', '-A')
    git(work, 'commit', '-m', subject)
  }

  // 13 template-owned files, as the first commit of tabsii-platform#1480 had
  // (that repo is private: the shape is reproduced from the PR, not fetched).
  const upgradeFiles = (): Record<string, string> => {
    const files: Record<string, string> = {
      'biffo.core.json': '{"version":"0.384.0"}',
      'package.json': '{"v":2}',
      '.githooks/pre-push': '#!/bin/sh\n# 2',
      'scripts/verify.sh': '#!/bin/sh\n# 2',
      'scripts/pgtest-diff-check.sh': '#!/bin/sh\n# 2',
    }
    for (let i = 0; i < 8; i++) files[`scripts/upgrade-fixture-${i}.sh`] = `# ${i}`
    return files
  }

  it('exempts the first commit when it has the CLI subject, on fleet/issue-1582', async () => {
    git(work, 'switch', '-c', 'fleet/issue-1582')
    commit(upgradeFiles(), CLI_SUBJECT)
    process.env['GITHUB_HEAD_REF'] = 'fleet/issue-1582'
    await runOwnershipCheck([])
    expect(errors.filter((e) => e.includes('template-owned'))).toEqual([])
    expect(logs.join('')).toContain('skipped — this is a core-upgrade branch')
  })

  it('still checks later commits on that branch', async () => {
    git(work, 'switch', '-c', 'fleet/issue-1582')
    commit(upgradeFiles(), CLI_SUBJECT)
    commit({ 'scripts/hand-edit.sh': '#' }, 'fix: tweak')
    process.env['GITHUB_HEAD_REF'] = 'fleet/issue-1582'
    await expect(runOwnershipCheck([])).rejects.toThrow('exit:1')
    expect(errors.join('')).toContain('scripts/hand-edit.sh')
  })

  it('refuses biffo-platform#253: a hand-merged "feat: implement" commit', async () => {
    git(work, 'switch', '-c', 'fleet/issue-252')
    // Real file list of the commit's first commit (62026ae0).
    commit(
      {
        'biffo.core.json': '{"version":"0.371.0"}',
        'infra/environments/dev/core-api.instance.tf': '# x',
        'pnpm-lock.yaml': 'x',
        'package.json': '{"hand":"merged"}',
        'uv.lock': 'x',
      },
      'feat: implement #252',
    )
    process.env['GITHUB_HEAD_REF'] = 'fleet/issue-252'
    await expect(runOwnershipCheck([])).rejects.toThrow('exit:1')
    expect(errors.join('')).toContain('package.json')
  })
})
