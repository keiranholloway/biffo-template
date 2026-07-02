import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDataImport } from './data-import.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const execSyncMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execSync: execSyncMock }))

const promptMock = vi.hoisted(() => vi.fn())
vi.mock('inquirer', () => ({ default: { prompt: (...args: unknown[]) => promptMock(...args) } }))

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'biffo-project-'))
  mkdirSync(join(dir, 'services'), { recursive: true })
  return dir
}

function makeLocalSourceDir(
  files: Record<string, string> = { '000_first.sql': 'SELECT 1;' },
): string {
  const dir = mkdtempSync(join(tmpdir(), 'biffo-data-src-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
  return dir
}

function makeGitMock(clonedDir?: string) {
  return {
    isGitRepo: vi.fn().mockResolvedValue(true),
    cloneToTemp: vi.fn().mockResolvedValue(clonedDir ?? makeLocalSourceDir()),
    cleanup: vi.fn((dir: string) => {
      rmSync(dir, { recursive: true, force: true })
    }),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
  }
}

describe('runDataImport', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = makeProjectRoot()
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('rejects an invalid import name', async () => {
    const git = makeGitMock()

    await expect(
      runDataImport(
        'Not_Valid!',
        { source: makeLocalSourceDir(), dryRun: false, cwd: projectRoot },
        { git: git as never },
      ),
    ).rejects.toThrow('Invalid import name')

    expect(git.cloneToTemp).not.toHaveBeenCalled()
  })

  it('rejects when cwd has no services/ directory', async () => {
    const notAProject = mkdtempSync(join(tmpdir(), 'not-a-biffo-project-'))
    const git = makeGitMock()

    try {
      await expect(
        runDataImport(
          'tabsii',
          { source: makeLocalSourceDir(), dryRun: false, cwd: notAProject },
          { git: git as never },
        ),
      ).rejects.toThrow('root of a Biffo project checkout')
    } finally {
      rmSync(notAProject, { recursive: true, force: true })
    }
  })

  it('rejects when the import name is already present', async () => {
    mkdirSync(join(projectRoot, 'db', 'imports', 'tabsii'), { recursive: true })
    const git = makeGitMock()

    await expect(
      runDataImport(
        'tabsii',
        { source: makeLocalSourceDir(), dryRun: false, cwd: projectRoot },
        { git: git as never },
      ),
    ).rejects.toThrow('already present')

    expect(git.cloneToTemp).not.toHaveBeenCalled()
  })

  describe('local directory source', () => {
    it('copies only .sql files (sorted) into db/imports/<name>/ and commits', async () => {
      const sourceDir = makeLocalSourceDir({
        '001_second.sql': 'SELECT 2;',
        '000_first.sql': 'SELECT 1;',
        'README.md': 'not sql',
      })
      const git = makeGitMock()

      await runDataImport(
        'tabsii',
        { source: sourceDir, dryRun: false, cwd: projectRoot },
        { git: git as never },
      )

      const targetDir = join(projectRoot, 'db', 'imports', 'tabsii')
      expect(existsSync(join(targetDir, '000_first.sql'))).toBe(true)
      expect(existsSync(join(targetDir, '001_second.sql'))).toBe(true)
      expect(existsSync(join(targetDir, 'README.md'))).toBe(false)
      expect(readFileSync(join(targetDir, '000_first.sql'), 'utf8')).toBe('SELECT 1;')

      expect(git.cloneToTemp).not.toHaveBeenCalled()
      expect(git.add).toHaveBeenCalledWith(projectRoot, ['db/imports/tabsii'])
      expect(git.commit).toHaveBeenCalledWith(
        projectRoot,
        'feat(data): import tabsii (2 SQL file(s))',
      )
    })

    it('resolves --path as a subdirectory of the local source', async () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'biffo-data-src-'))
      mkdirSync(join(sourceDir, 'ddl', 'modules'), { recursive: true })
      writeFileSync(join(sourceDir, 'ddl', 'modules', '000_first.sql'), 'SELECT 1;')
      const git = makeGitMock()

      await runDataImport(
        'tabsii',
        { source: sourceDir, path: 'ddl/modules', dryRun: false, cwd: projectRoot },
        { git: git as never },
      )

      expect(existsSync(join(projectRoot, 'db', 'imports', 'tabsii', '000_first.sql'))).toBe(true)
    })

    it('rejects when no .sql files are found at the source', async () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'biffo-data-src-empty-'))
      writeFileSync(join(sourceDir, 'README.md'), 'not sql')
      const git = makeGitMock()

      await expect(
        runDataImport(
          'tabsii',
          { source: sourceDir, dryRun: false, cwd: projectRoot },
          { git: git as never },
        ),
      ).rejects.toThrow('No .sql files found')

      expect(git.add).not.toHaveBeenCalled()
    })

    it('warns but still imports files without a numeric-prefix filename', async () => {
      const { log } = await import('../lib/logger.js')
      const sourceDir = makeLocalSourceDir({ 'schema.sql': 'SELECT 1;' })
      const git = makeGitMock()

      await runDataImport(
        'tabsii',
        { source: sourceDir, dryRun: false, cwd: projectRoot },
        { git: git as never },
      )

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("don't start with a digit"))
      expect(existsSync(join(projectRoot, 'db', 'imports', 'tabsii', 'schema.sql'))).toBe(true)
    })

    describe('--dry-run', () => {
      it('does not write files, stage, or commit', async () => {
        const sourceDir = makeLocalSourceDir()
        const git = makeGitMock()

        await runDataImport(
          'tabsii',
          { source: sourceDir, dryRun: true, cwd: projectRoot },
          { git: git as never },
        )

        expect(git.add).not.toHaveBeenCalled()
        expect(git.commit).not.toHaveBeenCalled()
        expect(existsSync(join(projectRoot, 'db', 'imports', 'tabsii'))).toBe(false)
      })
    })
  })

  describe('GitHub URL source', () => {
    it('clones with the given token embedded via GitAdapter and cleans up after committing', async () => {
      const clonedDir = makeLocalSourceDir()
      const git = makeGitMock(clonedDir)

      await runDataImport(
        'tabsii',
        {
          source: 'https://github.com/acme/data-model.git',
          token: 'ghp_abc123',
          dryRun: false,
          cwd: projectRoot,
        },
        { git: git as never },
      )

      expect(git.cloneToTemp).toHaveBeenCalledWith(
        'https://github.com/acme/data-model.git',
        'biffo-data-tabsii',
        'ghp_abc123',
      )
      expect(existsSync(join(projectRoot, 'db', 'imports', 'tabsii', '000_first.sql'))).toBe(true)
      expect(git.cleanup).toHaveBeenCalledWith(clonedDir)
      expect(existsSync(clonedDir)).toBe(false)
    })

    it('resolves --path as a subdirectory of the cloned repo', async () => {
      const clonedDir = mkdtempSync(join(tmpdir(), 'biffo-data-src-'))
      mkdirSync(join(clonedDir, 'ddl', 'modules'), { recursive: true })
      writeFileSync(join(clonedDir, 'ddl', 'modules', '000_first.sql'), 'SELECT 1;')
      const git = makeGitMock(clonedDir)

      await runDataImport(
        'tabsii',
        {
          source: 'https://github.com/acme/data-model.git',
          path: 'ddl/modules',
          token: 'ghp_abc123',
          dryRun: false,
          cwd: projectRoot,
        },
        { git: git as never },
      )

      expect(existsSync(join(projectRoot, 'db', 'imports', 'tabsii', '000_first.sql'))).toBe(true)
    })

    it('cleans up the temp clone even when the manifest is invalid downstream', async () => {
      const clonedDir = mkdtempSync(join(tmpdir(), 'biffo-data-src-empty-'))
      const git = makeGitMock(clonedDir)

      await expect(
        runDataImport(
          'tabsii',
          {
            source: 'https://github.com/acme/data-model.git',
            token: 'ghp_abc123',
            dryRun: false,
            cwd: projectRoot,
          },
          { git: git as never },
        ),
      ).rejects.toThrow('No .sql files found')

      expect(git.cleanup).toHaveBeenCalledWith(clonedDir)
    })

    it('propagates a clone failure', async () => {
      const git = makeGitMock()
      git.cloneToTemp.mockRejectedValue(
        new Error('Failed to clone https://github.com/acme/data-model.git: not found'),
      )

      await expect(
        runDataImport(
          'tabsii',
          {
            source: 'https://github.com/acme/data-model.git',
            token: 'ghp_abc123',
            dryRun: false,
            cwd: projectRoot,
          },
          { git: git as never },
        ),
      ).rejects.toThrow('Failed to clone')
    })
  })

  describe('token resolution (no explicit --token)', () => {
    const originalEnv = process.env['BIFFO_DATA_IMPORT_TOKEN']

    beforeEach(() => {
      execSyncMock.mockReset()
      promptMock.mockReset()
      delete process.env['BIFFO_DATA_IMPORT_TOKEN']
    })

    afterEach(() => {
      if (originalEnv === undefined) delete process.env['BIFFO_DATA_IMPORT_TOKEN']
      else process.env['BIFFO_DATA_IMPORT_TOKEN'] = originalEnv
    })

    it('prefers BIFFO_DATA_IMPORT_TOKEN over gh auth token', async () => {
      process.env['BIFFO_DATA_IMPORT_TOKEN'] = 'env-token'
      const git = makeGitMock()

      await runDataImport(
        'tabsii',
        { source: 'https://github.com/acme/data-model.git', dryRun: false, cwd: projectRoot },
        { git: git as never },
      )

      expect(git.cloneToTemp).toHaveBeenCalledWith(
        'https://github.com/acme/data-model.git',
        'biffo-data-tabsii',
        'env-token',
      )
      expect(execSyncMock).not.toHaveBeenCalled()
    })

    it('falls back to gh auth token when no env var is set', async () => {
      execSyncMock.mockReturnValue(Buffer.from('gh-cli-token\n'))
      const git = makeGitMock()

      await runDataImport(
        'tabsii',
        { source: 'https://github.com/acme/data-model.git', dryRun: false, cwd: projectRoot },
        { git: git as never },
      )

      expect(execSyncMock).toHaveBeenCalledWith('gh auth token', expect.any(Object))
      expect(git.cloneToTemp).toHaveBeenCalledWith(
        'https://github.com/acme/data-model.git',
        'biffo-data-tabsii',
        'gh-cli-token',
      )
    })

    it('falls back to an interactive prompt when gh auth token fails, and clones unauthenticated on an empty answer', async () => {
      execSyncMock.mockImplementation(() => {
        throw new Error('gh not authenticated')
      })
      promptMock.mockResolvedValue({ token: '' })
      const git = makeGitMock()

      await runDataImport(
        'tabsii',
        { source: 'https://github.com/acme/data-model.git', dryRun: false, cwd: projectRoot },
        { git: git as never },
      )

      expect(promptMock).toHaveBeenCalled()
      expect(git.cloneToTemp).toHaveBeenCalledWith(
        'https://github.com/acme/data-model.git',
        'biffo-data-tabsii',
        undefined,
      )
    })
  })
})
