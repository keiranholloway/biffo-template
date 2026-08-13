import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { writePluginProvenance } from './plugin-provenance.js'
import {
  checkPluginStaleness,
  exitCodeForStaleness,
  formatStalenessReport,
  type PluginStalenessResult,
} from './plugin-staleness.js'

const MANIFEST = { name: 'widgets', version: '1.0.0', tables: [], api_routes: [] }

function makeProjectRoot(): string {
  return makeTmpDir('biffo-project')
}

function vendorPlugin(
  projectRoot: string,
  name: string,
  opts: { manifest?: unknown; files?: Record<string, string> } = {},
): string {
  const dir = join(projectRoot, 'services', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'biffo.plugin.json'), JSON.stringify(opts.manifest ?? MANIFEST))
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

function makeRegistryMock(entries: Array<{ name: string; repo: string }> = []) {
  return {
    fetchRegistry: vi.fn().mockResolvedValue({
      schema_version: '1',
      last_updated: '2026-01-01',
      plugins: entries.map((e) => ({
        name: e.name,
        version: '1.0.0',
        minor_version: '1.0',
        repo: e.repo,
        status: 'active',
      })),
    }),
  }
}

/** A fully-stubbed GitAdapter surface — only the methods plugin-staleness.ts
 * actually calls. Every test overrides just what it needs. */
function makeGitMock(overrides: Record<string, unknown> = {}) {
  return {
    resolveDefaultBranchSha: vi.fn().mockResolvedValue(null),
    cloneForEditing: vi.fn().mockRejectedValue(new Error('not stubbed')),
    cloneToTemp: vi.fn().mockRejectedValue(new Error('not stubbed')),
    countBehind: vi.fn().mockResolvedValue(null),
    cleanup: vi.fn(),
    ...overrides,
  }
}

function resultFor(results: PluginStalenessResult[], name: string): PluginStalenessResult {
  const r = results.find((x) => x.name === name)
  if (!r) throw new Error(`no result for ${name}`)
  return r
}

describe('checkPluginStaleness', () => {
  it('returns nothing when services/ holds no vendored plugins', async () => {
    const root = makeProjectRoot()
    const results = await checkPluginStaleness(root, {
      registry: makeRegistryMock() as never,
      git: makeGitMock() as never,
    })
    expect(results).toEqual([])
  })

  describe('the cheap (provenance) path', () => {
    it('reports up-to-date when the recorded SHA matches the remote HEAD — no clone needed', async () => {
      const root = makeProjectRoot()
      const dir = vendorPlugin(root, 'widgets')
      const sha = 'a'.repeat(40)
      writePluginProvenance(dir, {
        origin: 'https://github.com/acme/widgets',
        ref: null,
        sha,
        recordedAt: '2026-01-01T00:00:00.000Z',
        inTree: false,
      })
      const git = makeGitMock({ resolveDefaultBranchSha: vi.fn().mockResolvedValue(sha) })

      const results = await checkPluginStaleness(root, {
        registry: makeRegistryMock() as never,
        git: git as never,
      })

      expect(resultFor(results, 'widgets').status).toBe('up-to-date')
      expect(git.cloneForEditing).not.toHaveBeenCalled()
    })

    it('reports N commits behind when the SHAs differ', async () => {
      const root = makeProjectRoot()
      const dir = vendorPlugin(root, 'widgets')
      const oldSha = 'a'.repeat(40)
      const newSha = 'b'.repeat(40)
      writePluginProvenance(dir, {
        origin: 'https://github.com/acme/widgets',
        ref: null,
        sha: oldSha,
        recordedAt: '2026-01-01T00:00:00.000Z',
        inTree: false,
      })
      const git = makeGitMock({
        resolveDefaultBranchSha: vi.fn().mockResolvedValue(newSha),
        cloneForEditing: vi.fn().mockResolvedValue('/tmp/fake-clone'),
        countBehind: vi.fn().mockResolvedValue(4),
      })

      const results = await checkPluginStaleness(root, {
        registry: makeRegistryMock() as never,
        git: git as never,
      })

      const result = resultFor(results, 'widgets')
      expect(result.status).toBe('behind')
      expect(result.commitsBehind).toBe(4)
      expect(git.cleanup).toHaveBeenCalledWith('/tmp/fake-clone')
    })

    it('reports cannot-tell, not up-to-date, when the source is unreachable', async () => {
      const root = makeProjectRoot()
      const dir = vendorPlugin(root, 'widgets')
      writePluginProvenance(dir, {
        origin: 'https://github.com/acme/widgets',
        ref: null,
        sha: 'a'.repeat(40),
        recordedAt: '2026-01-01T00:00:00.000Z',
        inTree: false,
      })
      // resolveDefaultBranchSha defaults to null in makeGitMock — an
      // unreachable/unauthenticated source, honestly reported.
      const git = makeGitMock()

      const results = await checkPluginStaleness(root, {
        registry: makeRegistryMock() as never,
        git: git as never,
      })

      const result = resultFor(results, 'widgets')
      expect(result.status).toBe('cannot-tell')
      expect(result.status).not.toBe('up-to-date')
      expect(exitCodeForStaleness(results)).toBe(2)
    })

    it('reports cannot-tell when the recorded SHA is not found in a rebased/force-pushed history', async () => {
      const root = makeProjectRoot()
      const dir = vendorPlugin(root, 'widgets')
      writePluginProvenance(dir, {
        origin: 'https://github.com/acme/widgets',
        ref: null,
        sha: 'a'.repeat(40),
        recordedAt: '2026-01-01T00:00:00.000Z',
        inTree: false,
      })
      const git = makeGitMock({
        resolveDefaultBranchSha: vi.fn().mockResolvedValue('b'.repeat(40)),
        cloneForEditing: vi.fn().mockResolvedValue('/tmp/fake-clone'),
        countBehind: vi.fn().mockResolvedValue(null), // sha unresolvable in the clone
      })

      const results = await checkPluginStaleness(root, {
        registry: makeRegistryMock() as never,
        git: git as never,
      })

      expect(resultFor(results, 'widgets').status).toBe('cannot-tell')
    })
  })

  describe('the content-diff fallback (no provenance)', () => {
    it('reports up-to-date when a local --local source is byte-identical', async () => {
      const root = makeProjectRoot()
      const localSource = makeTmpDir('plugin-source')
      writeFileSync(join(localSource, 'biffo.plugin.json'), JSON.stringify(MANIFEST))
      writeFileSync(join(localSource, 'main.py'), 'x = 1\n')

      const dir = vendorPlugin(root, 'widgets', { files: { 'main.py': 'x = 1\n' } })
      writePluginProvenance(dir, {
        origin: localSource,
        ref: null,
        sha: null, // non-git local source — no SHA on record
        recordedAt: '2026-01-01T00:00:00.000Z',
        inTree: false,
      })

      const results = await checkPluginStaleness(root, {
        registry: makeRegistryMock() as never,
        git: makeGitMock() as never,
      })

      const result = resultFor(results, 'widgets')
      expect(result.status).toBe('up-to-date')
      expect(result.method).toBe('content-diff')
    })

    it('reports behind with a file-difference count when content differs', async () => {
      const root = makeProjectRoot()
      const localSource = makeTmpDir('plugin-source')
      writeFileSync(join(localSource, 'biffo.plugin.json'), JSON.stringify(MANIFEST))
      writeFileSync(join(localSource, 'main.py'), 'x = 2\n') // changed upstream
      writeFileSync(join(localSource, 'new_route.py'), 'y = 1\n') // new upstream file

      const dir = vendorPlugin(root, 'widgets', { files: { 'main.py': 'x = 1\n' } })
      writePluginProvenance(dir, {
        origin: localSource,
        ref: null,
        sha: null,
        recordedAt: '2026-01-01T00:00:00.000Z',
        inTree: false,
      })

      const results = await checkPluginStaleness(root, {
        registry: makeRegistryMock() as never,
        git: makeGitMock() as never,
      })

      const result = resultFor(results, 'widgets')
      expect(result.status).toBe('behind')
      // main.py (changed) + new_route.py (missing from the vendored copy) = 2.
      expect(result.filesDiffering).toBe(2)
      expect(result.commitsBehind).toBeUndefined()
    })

    it('never counts the provenance file itself as drift', async () => {
      const root = makeProjectRoot()
      const localSource = makeTmpDir('plugin-source')
      writeFileSync(join(localSource, 'biffo.plugin.json'), JSON.stringify(MANIFEST))

      // The vendored copy carries .biffo-plugin-provenance.json; the source
      // (correctly) does not — that must not, by itself, read as drift.
      const dir = vendorPlugin(root, 'widgets')
      writePluginProvenance(dir, {
        origin: localSource,
        ref: null,
        sha: null,
        recordedAt: '2026-01-01T00:00:00.000Z',
        inTree: false,
      })

      const results = await checkPluginStaleness(root, {
        registry: makeRegistryMock() as never,
        git: makeGitMock() as never,
      })

      expect(resultFor(results, 'widgets').status).toBe('up-to-date')
    })

    it('falls back to the registry by plugin name when there is no provenance at all', async () => {
      const root = makeProjectRoot()
      // Vendored before #1547 existed — no provenance file.
      vendorPlugin(root, 'widgets')

      const git = makeGitMock({
        cloneToTemp: vi.fn().mockRejectedValue(new Error('offline')),
      })
      const registry = makeRegistryMock([
        { name: 'widgets', repo: 'https://github.com/acme/widgets' },
      ])

      const results = await checkPluginStaleness(root, {
        registry: registry as never,
        git: git as never,
      })

      // Registry resolved a repo, but the clone failed — cannot-tell, not a
      // silent "up to date".
      const result = resultFor(results, 'widgets')
      expect(result.status).toBe('cannot-tell')
      expect(result.status).not.toBe('up-to-date')
    })

    it('reports cannot-tell when there is no provenance and the plugin is not in the registry', async () => {
      const root = makeProjectRoot()
      vendorPlugin(root, 'widgets')

      const results = await checkPluginStaleness(root, {
        registry: makeRegistryMock([]) as never,
        git: makeGitMock() as never,
      })

      expect(resultFor(results, 'widgets').status).toBe('cannot-tell')
    })
  })

  it('reports cannot-tell for an in-tree --local install — there is no external source', async () => {
    const root = makeProjectRoot()
    const dir = vendorPlugin(root, 'widgets')
    writePluginProvenance(dir, {
      origin: 'services/widgets',
      ref: null,
      sha: null,
      recordedAt: '2026-01-01T00:00:00.000Z',
      inTree: true,
    })

    const results = await checkPluginStaleness(root, {
      registry: makeRegistryMock() as never,
      git: makeGitMock() as never,
    })

    expect(resultFor(results, 'widgets').status).toBe('cannot-tell')
  })

  it('reports invalid provenance JSON as cannot-tell, not a silent fallback', async () => {
    const root = makeProjectRoot()
    const dir = vendorPlugin(root, 'widgets')
    writeFileSync(join(dir, '.biffo-plugin-provenance.json'), '{ broken')

    const results = await checkPluginStaleness(root, {
      registry: makeRegistryMock() as never,
      git: makeGitMock() as never,
    })

    expect(resultFor(results, 'widgets').status).toBe('cannot-tell')
  })

  it('never inspects services/_template or services/api as plugins', async () => {
    const root = makeProjectRoot()
    mkdirSync(join(root, 'services', '_template'), { recursive: true })
    mkdirSync(join(root, 'services', 'api'), { recursive: true })

    const results = await checkPluginStaleness(root, {
      registry: makeRegistryMock() as never,
      git: makeGitMock() as never,
    })

    expect(results).toEqual([])
  })
})

describe('exitCodeForStaleness', () => {
  const upToDate: PluginStalenessResult = {
    name: 'a',
    status: 'up-to-date',
    method: 'provenance',
    detail: '',
  }
  const behind: PluginStalenessResult = {
    name: 'b',
    status: 'behind',
    method: 'provenance',
    detail: '',
    commitsBehind: 3,
  }
  const cannotTell: PluginStalenessResult = {
    name: 'c',
    status: 'cannot-tell',
    method: 'unresolvable',
    detail: '',
  }

  it('exits 0 when every plugin is up to date', () => {
    expect(exitCodeForStaleness([upToDate])).toBe(0)
  })

  it('exits 1 when at least one plugin is behind and none are cannot-tell', () => {
    expect(exitCodeForStaleness([upToDate, behind])).toBe(1)
  })

  it('exits 2 when at least one plugin is cannot-tell, even alongside up-to-date results', () => {
    expect(exitCodeForStaleness([upToDate, cannotTell])).toBe(2)
  })

  it('cannot-tell outranks behind — 2, never 1, when both are present', () => {
    expect(exitCodeForStaleness([behind, cannotTell])).toBe(2)
  })
})

describe('formatStalenessReport', () => {
  it('visibly distinguishes cannot-tell from up-to-date in the printed report', () => {
    const report = formatStalenessReport([
      { name: 'a', status: 'up-to-date', method: 'provenance', detail: 'matches upstream' },
      { name: 'b', status: 'cannot-tell', method: 'unresolvable', detail: 'offline' },
    ])
    expect(report).toContain('up to date')
    expect(report).toContain('CANNOT TELL')
    expect(report).not.toMatch(/CANNOT TELL.*up to date/s)
  })

  it('handles an empty result set without implying anything was checked', () => {
    expect(formatStalenessReport([])).toMatch(/nothing to check/i)
  })
})
