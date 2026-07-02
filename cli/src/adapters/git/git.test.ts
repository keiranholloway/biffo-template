import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitAdapter } from './index.js'

vi.mock('execa', () => ({ execa: vi.fn() }))

const execaMock = vi.mocked(execa)

describe('GitAdapter', () => {
  let adapter: GitAdapter

  beforeEach(() => {
    adapter = new GitAdapter()
    execaMock.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('isGitRepo', () => {
    it('returns true when git rev-parse succeeds', async () => {
      execaMock.mockResolvedValue({} as never)
      await expect(adapter.isGitRepo('/some/repo')).resolves.toBe(true)
      expect(execaMock).toHaveBeenCalledWith('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: '/some/repo',
      })
    })

    it('returns false when git rev-parse fails', async () => {
      execaMock.mockRejectedValue(new Error('not a git repository'))
      await expect(adapter.isGitRepo('/tmp')).resolves.toBe(false)
    })
  })

  describe('cloneToTemp', () => {
    it('clones into a fresh temp directory and strips .git', async () => {
      execaMock.mockImplementation(async (_cmd, args) => {
        const dir = (args as string[])[(args as string[]).length - 1]!
        mkdirSync(join(dir, '.git'), { recursive: true })
        writeFileSync(join(dir, 'biffo.plugin.json'), '{"name":"widgets","version":"1.0.0"}')
        return {} as never
      })

      const dir = await adapter.cloneToTemp(
        'https://example.com/plugin.git',
        'biffo-plugin-widgets',
      )

      expect(existsSync(join(dir, '.git'))).toBe(false)
      expect(existsSync(join(dir, 'biffo.plugin.json'))).toBe(true)
      expect(execaMock).toHaveBeenCalledWith('git', [
        'clone',
        '--depth',
        '1',
        'https://example.com/plugin.git',
        dir,
      ])

      adapter.cleanup(dir)
    })

    it('cleans up the temp directory and throws a clear error when clone fails', async () => {
      let capturedDir = ''
      execaMock.mockImplementation(async (_cmd, args) => {
        capturedDir = (args as string[])[(args as string[]).length - 1]!
        throw new Error('repository not found')
      })

      await expect(
        adapter.cloneToTemp('https://example.com/missing.git', 'biffo-plugin-missing'),
      ).rejects.toThrow('Failed to clone https://example.com/missing.git')

      expect(existsSync(capturedDir)).toBe(false)
    })
  })

  describe('add / commit', () => {
    it('stages the given paths', async () => {
      execaMock.mockResolvedValue({} as never)
      await adapter.add('/repo', ['services/widgets', 'modules/plugins/widgets'])
      expect(execaMock).toHaveBeenCalledWith(
        'git',
        ['add', 'services/widgets', 'modules/plugins/widgets'],
        { cwd: '/repo' },
      )
    })

    it('commits with the given message', async () => {
      execaMock.mockResolvedValue({} as never)
      await adapter.commit('/repo', 'feat(plugins): install widgets@1.0.0')
      expect(execaMock).toHaveBeenCalledWith(
        'git',
        ['commit', '-m', 'feat(plugins): install widgets@1.0.0'],
        { cwd: '/repo' },
      )
    })
  })
})
