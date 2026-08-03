import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { capturedOutput } from '../test-utils/console.js'
import { runDataList } from './data-list.js'
import { makeTmpDir } from '../test-utils/tmp.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function makeProjectRoot(): string {
  return makeTmpDir('biffo-project')
}

function writeSqlFiles(projectRoot: string, importName: string, filenames: string[]): void {
  const dir = join(projectRoot, 'db', 'imports', importName)
  mkdirSync(dir, { recursive: true })
  for (const name of filenames) {
    writeFileSync(join(dir, name), 'SELECT 1;')
  }
}

describe('runDataList', () => {
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

  it('reports no DDL imports when db/imports/ does not exist', async () => {
    await runDataList({ cwd: projectRoot })
    const output = capturedOutput(logSpy)
    expect(output).toContain('No DDL imports')
  })

  it('reports no DDL imports when db/imports/ is empty', async () => {
    mkdirSync(join(projectRoot, 'db', 'imports'), { recursive: true })
    await runDataList({ cwd: projectRoot })
    const output = capturedOutput(logSpy)
    expect(output).toContain('No DDL imports')
  })

  it('lists each import directory by name and .sql file count', async () => {
    writeSqlFiles(projectRoot, 'tabsii', ['000_schema.sql', '001_tables.sql'])
    writeSqlFiles(projectRoot, 'analytics', ['000_init.sql'])

    await runDataList({ cwd: projectRoot })

    const output = capturedOutput(logSpy)
    expect(output).toContain('tabsii')
    expect(output).toContain('analytics')
    // tabsii has 2 files, analytics has 1
    const tabsiiLine = logSpy.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('tabsii'))
    expect(tabsiiLine).toMatch(/2/)
  })

  it('ignores import directories with no .sql files', async () => {
    const dir = join(projectRoot, 'db', 'imports', 'empty')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'README.md'), 'not sql')

    await runDataList({ cwd: projectRoot })

    const output = capturedOutput(logSpy)
    expect(output).toContain('No DDL imports')
    expect(output).not.toContain('empty')
  })

  it('mentions that this is local-only, not a live applied-status check', async () => {
    writeSqlFiles(projectRoot, 'tabsii', ['000_schema.sql'])

    await runDataList({ cwd: projectRoot })

    const output = capturedOutput(logSpy)
    expect(output).toContain('biffo data apply')
  })
})
