import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { capturedOutput } from '../test-utils/console.js'
import { runCoreStatus } from './core-status.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { log } from '../lib/logger.js'

function writeInstance(dir: string, version: string): void {
  writeFileSync(join(dir, 'biffo.core.json'), JSON.stringify({ version }))
}

describe('runCoreStatus', () => {
  let cwd: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'biffo-instance-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.clearAllMocks()
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  function output(): string {
    return capturedOutput(logSpy)
  }

  it('warns and hints when no biffo.core.json is present', async () => {
    await runCoreStatus({ cwd, latest: '0.1.0' })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('No biffo.core.json'))
    expect(output()).toContain('--cwd')
  })

  it('reports up to date when current equals latest', async () => {
    writeInstance(cwd, '0.1.0')
    await runCoreStatus({ cwd, latest: '0.1.0' })
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Up to date'))
    expect(log.info).not.toHaveBeenCalled()
  })

  it('reports an available upgrade when current is behind latest', async () => {
    writeInstance(cwd, '0.1.0')
    await runCoreStatus({ cwd, latest: '0.3.0' })
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('0.1.0 → 0.3.0'))
    // mentions the later-phase commands
    expect(output()).toContain('biffo core upgrade')
  })

  it('warns when the instance core is ahead of the CLI', async () => {
    writeInstance(cwd, '0.5.0')
    await runCoreStatus({ cwd, latest: '0.3.0' })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('ahead of this CLI'))
  })

  it('surfaces a malformed biffo.core.json as an error (not "up to date")', async () => {
    writeFileSync(join(cwd, 'biffo.core.json'), '{ broken')
    await expect(runCoreStatus({ cwd, latest: '0.1.0' })).rejects.toThrow(/not valid JSON/)
  })
})
