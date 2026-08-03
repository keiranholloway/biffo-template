import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { capturedLines, capturedOutput } from '../test-utils/console.js'
import { runPluginList } from './plugin-list.js'
import { makeTmpDir } from '../test-utils/tmp.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const MANIFEST = (name: string, version: string) => ({
  name,
  version,
  description: `${name} plugin`,
  tables: [],
  api_routes: [],
})

function makeProjectRoot(): string {
  return makeTmpDir('biffo-project')
}

function writeManifest(projectRoot: string, dirName: string, manifest: unknown): void {
  const dir = join(projectRoot, 'services', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'biffo.plugin.json'), JSON.stringify(manifest))
}

describe('runPluginList', () => {
  let projectRoot: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    projectRoot = makeProjectRoot()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  it('rejects when cwd has no services/ directory', async () => {
    const notAProject = makeTmpDir('not-a-biffo-project')
    try {
      await expect(runPluginList({ cwd: notAProject })).rejects.toThrow(
        'root of a Biffo project checkout',
      )
    } finally {
      rmSync(notAProject, { recursive: true, force: true })
    }
  })

  it('reports no plugins installed when services/ is empty', async () => {
    mkdirSync(join(projectRoot, 'services'), { recursive: true })
    await runPluginList({ cwd: projectRoot })
    const output = capturedOutput(logSpy)
    expect(output).toContain('No plugins installed')
  })

  it('lists each plugin directory with a biffo.plugin.json, by name and version', async () => {
    writeManifest(projectRoot, 'widgets', MANIFEST('widgets', '1.0.0'))
    writeManifest(projectRoot, 'rbac', MANIFEST('rbac', '2.3.1'))

    await runPluginList({ cwd: projectRoot })

    const output = capturedOutput(logSpy)
    expect(output).toContain('widgets')
    expect(output).toContain('1.0.0')
    expect(output).toContain('rbac')
    expect(output).toContain('2.3.1')
  })

  it('ignores service directories without a biffo.plugin.json', async () => {
    mkdirSync(join(projectRoot, 'services', 'api'), { recursive: true })
    writeFileSync(join(projectRoot, 'services', 'api', 'main.py'), '# not a plugin\n')

    await runPluginList({ cwd: projectRoot })

    const output = capturedOutput(logSpy)
    expect(output).toContain('No plugins installed')
    expect(output).not.toContain('services/api')
  })

  it('skips and warns on a directory with an invalid manifest rather than throwing', async () => {
    writeManifest(projectRoot, 'broken', { name: 'broken' }) // missing required `version`
    writeManifest(projectRoot, 'widgets', MANIFEST('widgets', '1.0.0'))

    await runPluginList({ cwd: projectRoot })

    const output = capturedOutput(logSpy)
    expect(output).toContain('widgets')
    expect(output).toContain('1.0.0')
  })

  it('does not show status or last-updated as table columns (no data source for them)', async () => {
    writeManifest(projectRoot, 'widgets', MANIFEST('widgets', '1.0.0'))

    await runPluginList({ cwd: projectRoot })

    const header = capturedLines(logSpy).find((line) => line.includes('NAME'))
    expect(header).toBeDefined()
    expect(header).not.toMatch(/\bSTATUS\b/)
    expect(header).not.toMatch(/LAST-UPDATED|LAST UPDATED/)
  })
})
