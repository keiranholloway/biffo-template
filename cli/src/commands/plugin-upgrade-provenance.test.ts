/**
 * Provenance-writing coverage for `runPluginUpgrade` (#1547), kept in its own
 * file for the same reason as plugin-install-provenance.test.ts: this file
 * is concurrently touched by #1554, and a new concern should not grow the
 * merge surface of the existing large suite.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegistryPluginEntry } from '../adapters/registry/index.js'
import { PLUGIN_PROVENANCE_FILENAME } from '../lib/plugin-provenance.js'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runPluginUpgrade } from './plugin-upgrade.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const promptMock = vi.fn()
vi.mock('inquirer', () => ({
  default: { prompt: (...args: unknown[]) => promptMock(...args) },
}))

const OLD_MANIFEST = { name: 'widgets', version: '1.0.0', tables: [], api_routes: [] }
const NEW_MANIFEST = { ...OLD_MANIFEST, version: '1.1.0' }

const REGISTRY_ENTRY: RegistryPluginEntry = {
  name: 'widgets',
  version: '1.1.0',
  minor_version: '1.1',
  repo: 'https://github.com/keiranholloway/biffo-plugin-widgets',
  status: 'active',
}

function makeProjectRoot(): string {
  const dir = makeTmpDir('biffo-project')
  mkdirSync(join(dir, 'services', 'widgets'), { recursive: true })
  writeFileSync(join(dir, 'services', 'widgets', 'biffo.plugin.json'), JSON.stringify(OLD_MANIFEST))
  return dir
}

function makeClonedPluginDir(manifest: unknown = NEW_MANIFEST): string {
  const dir = makeTmpDir('biffo-plugin-src')
  writeFileSync(join(dir, 'biffo.plugin.json'), JSON.stringify(manifest))
  return dir
}

function makeLocalPluginDir(manifest: unknown = NEW_MANIFEST): string {
  const dir = makeTmpDir('biffo-plugin-local')
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
    hasUncommittedChanges: vi.fn().mockResolvedValue(true),
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

describe('runPluginUpgrade — provenance (#1547)', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = makeProjectRoot()
    promptMock.mockReset()
    promptMock.mockResolvedValue({ confirmed: true })
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('writes provenance recording the registry repo and SHA on a registry upgrade', async () => {
    const sha = 'd'.repeat(40)
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir(), sha)
    const migrations = makeMigrationsMock()

    await runPluginUpgrade(
      'widgets@1.1',
      { dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    const record = readProvenanceFile(projectRoot, 'widgets')
    expect(record).toMatchObject({ origin: REGISTRY_ENTRY.repo, sha, inTree: false })
  })

  it('writes provenance for a --local refresh from a non-git checkout, with sha/ref null', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()
    const localDir = makeLocalPluginDir()

    await runPluginUpgrade(
      undefined,
      { local: localDir, dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    const record = readProvenanceFile(projectRoot, 'widgets')
    expect(record).toMatchObject({ origin: localDir, sha: null, ref: null, inTree: false })
  })

  it('writes in-tree provenance when --local points at its own installed location', async () => {
    const installedDir = join(projectRoot, 'services', 'widgets')
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginUpgrade(
      undefined,
      { local: installedDir, dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    const record = readProvenanceFile(projectRoot, 'widgets')
    expect(record['inTree']).toBe(true)
  })

  it('does not rewrite provenance (or its timestamp) on a byte-identical --local refresh', async () => {
    const installedDir = join(projectRoot, 'services', 'widgets')
    // Prime the installed copy so a second refresh from the SAME local
    // source is genuinely a no-op at the content level.
    const localDir = makeLocalPluginDir(OLD_MANIFEST)
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginUpgrade(
      undefined,
      { local: localDir, dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )
    const first = readFileSync(join(installedDir, PLUGIN_PROVENANCE_FILENAME), 'utf8')

    await runPluginUpgrade(
      undefined,
      { local: localDir, dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )
    const second = readFileSync(join(installedDir, PLUGIN_PROVENANCE_FILENAME), 'utf8')

    // Same origin (non-git, so sha/ref are always null both times) — the
    // provenance write must be idempotent rather than touching recordedAt
    // on every call, which would turn every refresh into a spurious diff.
    expect(second).toBe(first)
  })
})
