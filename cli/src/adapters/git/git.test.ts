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

    it('embeds a given token as userinfo on an https URL passed to git clone', async () => {
      execaMock.mockResolvedValue({} as never)

      const dir = await adapter.cloneToTemp(
        'https://github.com/acme/private-repo.git',
        'biffo-data-acme',
        'ghp_supersecrettoken123',
      )

      expect(execaMock).toHaveBeenCalledWith('git', [
        'clone',
        '--depth',
        '1',
        'https://x-access-token:ghp_supersecrettoken123@github.com/acme/private-repo.git',
        dir,
      ])

      adapter.cleanup(dir)
    })

    it('never leaks the token in a thrown error message — only the original URL appears', async () => {
      execaMock.mockRejectedValue(new Error('authentication failed'))

      let caught: Error | undefined
      try {
        await adapter.cloneToTemp(
          'https://github.com/acme/private-repo.git',
          'biffo-data-acme',
          'ghp_supersecrettoken123',
        )
      } catch (err) {
        caught = err as Error
      }

      expect(caught?.message).toContain('https://github.com/acme/private-repo.git')
      expect(caught?.message).not.toContain('ghp_supersecrettoken123')
    })

    it('leaves a non-https URL (SSH, file://) unchanged even when a token is given', async () => {
      execaMock.mockResolvedValue({} as never)

      const dir = await adapter.cloneToTemp(
        'git@github.com:acme/private-repo.git',
        'biffo-data-acme',
        'ghp_supersecrettoken123',
      )

      expect(execaMock).toHaveBeenCalledWith('git', [
        'clone',
        '--depth',
        '1',
        'git@github.com:acme/private-repo.git',
        dir,
      ])

      adapter.cleanup(dir)
    })
  })

  describe('add / commit', () => {
    it('initializes a repo with an explicit initial branch', async () => {
      execaMock.mockResolvedValue({} as never)
      await adapter.init('/repo', 'main')
      expect(execaMock).toHaveBeenCalledWith('git', ['init', '-b', 'main'], { cwd: '/repo' })
    })

    it('adds a named remote', async () => {
      execaMock.mockResolvedValue({} as never)
      await adapter.addRemote('/repo', 'origin', 'https://github.com/acme/reports.git')
      expect(execaMock).toHaveBeenCalledWith(
        'git',
        ['remote', 'add', 'origin', 'https://github.com/acme/reports.git'],
        { cwd: '/repo' },
      )
    })

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

describe('GitAdapter core-upgrade ops (ADR-0006 Phase 3b)', () => {
  let adapter: GitAdapter
  beforeEach(() => {
    adapter = new GitAdapter()
    execaMock.mockReset()
  })

  it('currentBranch returns the trimmed branch name', async () => {
    execaMock.mockResolvedValue({ stdout: 'main\n' } as never)
    await expect(adapter.currentBranch('/r')).resolves.toBe('main')
    expect(execaMock).toHaveBeenCalledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: '/r',
    })
  })

  it('hasUncommittedChanges reflects porcelain output', async () => {
    execaMock.mockResolvedValue({ stdout: ' M file\n' } as never)
    await expect(adapter.hasUncommittedChanges('/r')).resolves.toBe(true)
    execaMock.mockResolvedValue({ stdout: '' } as never)
    await expect(adapter.hasUncommittedChanges('/r')).resolves.toBe(false)
  })

  it('createBranch switches to a new branch', async () => {
    execaMock.mockResolvedValue({} as never)
    await adapter.createBranch('/r', 'biffo/x')
    expect(execaMock).toHaveBeenCalledWith('git', ['switch', '-c', 'biffo/x'], { cwd: '/r' })
  })

  it('push injects the token into an HTTPS remote URL', async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: 'https://github.com/acme/app.git' } as never) // get-url
      .mockResolvedValueOnce({} as never) // push
    await adapter.push('/r', 'biffo/x', { token: 'SECRET' })
    const pushCall = execaMock.mock.calls.find((c) => (c[1] as string[])[0] === 'push')
    const url = (pushCall?.[1] as string[])[1]
    expect(url).toContain('x-access-token:SECRET@github.com')
  })

  it('push error message never leaks the token', async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: 'https://github.com/acme/app.git' } as never)
      .mockRejectedValueOnce(new Error('remote rejected https://x-access-token:SECRET@github.com'))
    await expect(adapter.push('/r', 'biffo/x', { token: 'SECRET' })).rejects.toThrow(
      /Failed to push branch 'biffo\/x'/,
    )
    await expect(adapter.push('/r', 'biffo/x', { token: 'SECRET' })).rejects.not.toThrow(/SECRET/)
  })

  // #758 — without an upstream the branch this tool creates is invisible to
  // both `git branch --merged` (squash-merge) and `: gone]` (no upstream).
  describe('push records the upstream (#758)', () => {
    const argsOf = (verb: string, key?: string) =>
      execaMock.mock.calls
        .map((c) => c[1] as string[])
        .filter((a) => a[0] === verb && (key === undefined || a[1] === key))

    it('sets branch.<name>.remote and .merge, naming the remote', async () => {
      execaMock.mockResolvedValue({} as never)
      await adapter.push('/r', 'biffo/x')
      expect(argsOf('config', 'branch.biffo/x.remote')[0]).toEqual([
        'config',
        'branch.biffo/x.remote',
        'origin',
      ])
      expect(argsOf('config', 'branch.biffo/x.merge')[0]).toEqual([
        'config',
        'branch.biffo/x.merge',
        'refs/heads/biffo/x',
      ])
    })

    it('writes the remote-tracking ref, so a fresh branch is not reported gone', async () => {
      // Pushing to a URL does not update refs/remotes/*, so without this a
      // just-pushed branch reads as `: gone]` — a live branch marked dead.
      execaMock.mockResolvedValue({} as never)
      await adapter.push('/r', 'biffo/x')
      expect(argsOf('update-ref')[0]).toEqual(['update-ref', 'refs/remotes/origin/biffo/x', 'HEAD'])
    })

    it('NEVER writes the tokenized URL into git config', async () => {
      // The whole reason `-u` is not used: it would persist whatever it pushed
      // to, and on this path that is a URL with a live credential in it.
      execaMock
        .mockResolvedValueOnce({ stdout: 'https://github.com/acme/app.git' } as never)
        .mockResolvedValue({} as never)
      await adapter.push('/r', 'biffo/x', { token: 'SECRET' })

      const configWrites = argsOf('config').flat().join(' ')
      expect(configWrites).not.toContain('SECRET')
      expect(configWrites).not.toContain('x-access-token')
      expect(configWrites).not.toContain('https://')
      expect(argsOf('config', 'branch.biffo/x.remote')[0]?.[2]).toBe('origin')
      // and no `-u`/`--set-upstream` on the push itself
      expect(argsOf('push')[0]).not.toContain('-u')
      expect(argsOf('push')[0]).not.toContain('--set-upstream')
    })

    it('honours a non-default remote name', async () => {
      execaMock.mockResolvedValue({} as never)
      await adapter.push('/r', 'biffo/x', { remote: 'upstream' })
      expect(argsOf('config', 'branch.biffo/x.remote')[0]?.[2]).toBe('upstream')
      expect(argsOf('update-ref')[0]?.[1]).toBe('refs/remotes/upstream/biffo/x')
    })

    it('does not set an upstream when the push failed', async () => {
      execaMock.mockRejectedValueOnce(new Error('rejected'))
      await expect(adapter.push('/r', 'biffo/x')).rejects.toThrow(/Failed to push/)
      expect(argsOf('config')).toHaveLength(0)
      expect(argsOf('update-ref')).toHaveLength(0)
    })
  })
})
