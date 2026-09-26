import { execa } from 'execa'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginMigrationsAdapter } from './index.js'

vi.mock('execa', () => ({ execa: vi.fn() }))

const execaMock = vi.mocked(execa)

describe('PluginMigrationsAdapter', () => {
  const cwd = '/tmp/biffo-project'
  let adapter: PluginMigrationsAdapter

  beforeEach(() => {
    execaMock.mockReset()
    adapter = new PluginMigrationsAdapter()
  })

  it('invokes the generator script with the expected --services-root/--versions-dir', async () => {
    execaMock.mockResolvedValue({ stdout: '' } as never)

    await adapter.generate(cwd)

    expect(execaMock).toHaveBeenCalledWith(
      'uv',
      [
        'run',
        'python',
        join(cwd, 'services', 'api', 'scripts', 'generate_plugin_migrations.py'),
        '--services-root',
        join(cwd, 'services'),
        '--versions-dir',
        join(cwd, 'services', 'api', 'migrations', 'versions'),
      ],
      expect.objectContaining({ cwd: join(cwd, 'services', 'api') }),
    )
  })

  it('passes a --plugin flag per named plugin', async () => {
    execaMock.mockResolvedValue({ stdout: '' } as never)

    await adapter.generate(cwd, ['rbac', 'billing'])

    expect(execaMock).toHaveBeenCalledWith(
      'uv',
      expect.arrayContaining(['--plugin', 'rbac', '--plugin', 'billing']),
      expect.any(Object),
    )
  })

  it('parses one generated path per stdout line', async () => {
    execaMock.mockResolvedValue({
      stdout: '/abs/path/one.py\n/abs/path/two.py',
    } as never)

    const result = await adapter.generate(cwd, ['rbac'])

    expect(result).toEqual(['/abs/path/one.py', '/abs/path/two.py'])
  })

  it('returns an empty array when stdout is empty (nothing generated)', async () => {
    execaMock.mockResolvedValue({ stdout: '' } as never)

    const result = await adapter.generate(cwd, ['rbac'])

    expect(result).toEqual([])
  })

  it('throws a friendly, actionable error when uv is not on PATH', async () => {
    const err = new Error('spawn uv ENOENT') as NodeJS.ErrnoException
    err.code = 'ENOENT'
    execaMock.mockRejectedValue(err)

    await expect(adapter.generate(cwd, ['rbac'])).rejects.toThrow(/needs `uv`/)
    await expect(adapter.generate(cwd, ['rbac'])).rejects.toThrow(/sync-migrations/)
  })

  it('includes the script’s stderr in the thrown error for a non-ENOENT failure', async () => {
    execaMock.mockRejectedValue({
      message: 'Command failed',
      stderr: 'No installed plugin manifest found for: nonexistent',
    })

    await expect(adapter.generate(cwd, ['nonexistent'])).rejects.toThrow(
      /No installed plugin manifest found for: nonexistent/,
    )
  })

  describe('refreshLock', () => {
    it('runs `uv lock` in the project root', async () => {
      execaMock.mockResolvedValue({ stdout: '' } as never)

      await adapter.refreshLock(cwd)

      expect(execaMock).toHaveBeenCalledWith('uv', ['lock'], expect.objectContaining({ cwd }))
    })

    it('throws an actionable error, naming the manual recovery, when uv is not on PATH', async () => {
      execaMock.mockRejectedValue(Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' }))

      await expect(adapter.refreshLock(cwd)).rejects.toThrow(
        /needs `uv`.*run `uv lock` and commit uv\.lock/s,
      )
    })

    it('includes uv’s stderr when the lock cannot be resolved', async () => {
      execaMock.mockRejectedValue(
        Object.assign(new Error('exit 1'), { stderr: ' no solution found ' }),
      )

      await expect(adapter.refreshLock(cwd)).rejects.toThrow(
        'Failed to refresh uv.lock (`uv lock`): no solution found',
      )
    })
  })
})
