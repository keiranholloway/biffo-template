/**
 * Provenance-writing coverage for `runPluginInstall` (#1547), kept in its own
 * file rather than added to plugin-install.test.ts's large shared suite —
 * that file is also being touched by concurrent work on #1554, and a new
 * concern belongs in a new file rather than growing merge surface on an
 * existing one.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegistryPluginEntry } from '../adapters/registry/index.js'
import { PLUGIN_PROVENANCE_FILENAME } from '../lib/plugin-provenance.js'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runPluginInstall } from './plugin-install.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const VALID_MANIFEST = {
  name: 'widgets',
  version: '1.0.0',
  description: 'Widgets plugin',
  tables: [],
  api_routes: [],
}

const REGISTRY_ENTRY: RegistryPluginEntry = {
  name: 'widgets',
  version: '1.0.0',
  minor_version: '1.0',
  repo: 'https://github.com/keiranholloway/biffo-plugin-widgets',
  status: 'active',
}

function makeProjectRoot(): string {
  const dir = makeTmpDir('biffo-project')
  mkdirSync(join(dir, 'services'), { recursive: true })
  return dir
}

function makeClonedPluginDir(manifest: unknown = VALID_MANIFEST): string {
  const dir = makeTmpDir('biffo-plugin-src')
  writeFileSync(join(dir, 'biffo.plugin.json'), JSON.stringify(manifest))
  return dir
}

function makeRegistryMock(entry: RegistryPluginEntry = REGISTRY_ENTRY) {
  return { resolvePlugin: vi.fn().mockResolvedValue(entry) }
}

function makeGitMock(clonedDir: string, resolvedSha: string | null = 'a'.repeat(40)) {
  return {
    isGitRepo: vi.fn().mockResolvedValue(true),
    cloneToTemp: vi.fn().mockResolvedValue(clonedDir),
    cleanup: vi.fn((dir: string) => rmSync(dir, { recursive: true, force: true })),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    resolveDefaultBranchSha: vi.fn().mockResolvedValue(resolvedSha),
  }
}

function makeMigrationsMock(generatedPaths: string[] = []) {
  return { generate: vi.fn().mockResolvedValue(generatedPaths) }
}

function readProvenanceFile(projectRoot: string, name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(projectRoot, 'services', name, PLUGIN_PROVENANCE_FILENAME), 'utf8'),
  )
}

describe('runPluginInstall — provenance (#1547)', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = makeProjectRoot()
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('writes provenance recording the registry repo and SHA on a registry install', async () => {
    const sha = 'c'.repeat(40)
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir(), sha)
    const migrations = makeMigrationsMock()

    await runPluginInstall(
      'widgets@1.0',
      { dryRun: false, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    const record = readProvenanceFile(projectRoot, 'widgets')
    expect(record).toMatchObject({ origin: REGISTRY_ENTRY.repo, sha, inTree: false })
    expect(git.resolveDefaultBranchSha).toHaveBeenCalledWith(REGISTRY_ENTRY.repo)
  })

  it('honestly records sha: null when the registry repo could not be reached', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir(), null)
    const migrations = makeMigrationsMock()

    await runPluginInstall(
      'widgets@1.0',
      { dryRun: false, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    const record = readProvenanceFile(projectRoot, 'widgets')
    expect(record['sha']).toBeNull()
  })

  it('writes provenance for a --local install from a non-git directory, with sha/ref null', async () => {
    const local = makeClonedPluginDir()
    const git = makeGitMock('')
    const migrations = makeMigrationsMock()

    await runPluginInstall(
      undefined,
      { local, dryRun: false, cwd: projectRoot },
      {
        registry: makeRegistryMock() as never,
        git: git as never,
        migrations: migrations as never,
      },
    )

    const record = readProvenanceFile(projectRoot, 'widgets')
    expect(record).toMatchObject({ origin: local, sha: null, ref: null, inTree: false })
    rmSync(local, { recursive: true, force: true })
  })

  it('writes in-tree provenance (no external source) when --local points at services/<name>/ itself', async () => {
    const inTree = join(projectRoot, 'services', 'widgets')
    mkdirSync(inTree, { recursive: true })
    writeFileSync(join(inTree, 'biffo.plugin.json'), JSON.stringify(VALID_MANIFEST))
    const git = makeGitMock('')

    await runPluginInstall(
      undefined,
      { local: inTree, dryRun: false, cwd: projectRoot },
      {
        registry: makeRegistryMock() as never,
        git: git as never,
        migrations: makeMigrationsMock() as never,
      },
    )

    const record = readProvenanceFile(projectRoot, 'widgets')
    expect(record['inTree']).toBe(true)
    expect(record['sha']).toBeNull()
  })

  it('stages the provenance file as part of services/<name>/, not separately', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginInstall(
      'widgets@1.0',
      { dryRun: false, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    // git.add is still called with the whole plugin directory — the
    // provenance file rides along automatically, no new stage path needed.
    expect(git.add).toHaveBeenCalledWith(projectRoot, ['services/widgets'])
    expect(existsSync(join(projectRoot, 'services', 'widgets', PLUGIN_PROVENANCE_FILENAME))).toBe(
      true,
    )
  })

  it('writes no provenance file when --dry-run', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginInstall(
      'widgets@1.0',
      { dryRun: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(false)
  })
})
