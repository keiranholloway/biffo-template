import { execa } from 'execa'
import { describe, expect, it, vi } from 'vitest'
import { GithubCliAdapter } from './index.js'

vi.mock('execa', () => ({ execa: vi.fn() }))

const execaMock = vi.mocked(execa)

/**
 * `GithubCliAdapter.prVerdictForBranch` (#1682) — the one signal `doctor
 * --fix` trusts to reap a branch, because local commit reachability is wrong
 * in both directions for a squash-merged PR. See `doctor-reaper.ts`'s module
 * doc for the full table this backs.
 */
describe('GithubCliAdapter.prVerdictForBranch', () => {
  const adapter = new GithubCliAdapter()

  function ghResult(states: string[], exitCode = 0): { stdout: string; exitCode: number } {
    return { stdout: JSON.stringify(states.map((state) => ({ state }))), exitCode }
  }

  it('shells to gh pr list with --state all so a resolved PR is not filtered out', async () => {
    execaMock.mockResolvedValue(ghResult(['MERGED']) as never)
    await adapter.prVerdictForBranch('/repo', 'chore/merged')
    expect(execaMock).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'list',
        '--head',
        'chore/merged',
        '--state',
        'all',
        '--json',
        'state',
        '--limit',
        '20',
      ],
      expect.objectContaining({ cwd: '/repo' }),
    )
  })

  it('returns merged for a branch whose PR merged', async () => {
    execaMock.mockResolvedValue(ghResult(['MERGED']) as never)
    await expect(adapter.prVerdictForBranch('/repo', 'chore/merged')).resolves.toBe('merged')
  })

  it('returns closed for a branch whose PR closed unmerged', async () => {
    execaMock.mockResolvedValue(ghResult(['CLOSED']) as never)
    await expect(adapter.prVerdictForBranch('/repo', 'fix/abandoned')).resolves.toBe('closed')
  })

  it('returns open when any matching PR is open, even alongside a closed one', async () => {
    execaMock.mockResolvedValue(ghResult(['CLOSED', 'OPEN']) as never)
    await expect(adapter.prVerdictForBranch('/repo', 'feat/reopened')).resolves.toBe('open')
  })

  it('returns merged when a branch carries both a closed and a later merged PR', async () => {
    // "was ever merged" is the fact that matters for reaping — a branch can
    // carry more than one PR across its life.
    execaMock.mockResolvedValue(ghResult(['CLOSED', 'MERGED']) as never)
    await expect(adapter.prVerdictForBranch('/repo', 'feat/retried')).resolves.toBe('merged')
  })

  it('returns none when no PR was ever opened from this branch', async () => {
    execaMock.mockResolvedValue(ghResult([]) as never)
    await expect(adapter.prVerdictForBranch('/repo', 'batch/reconverge-1')).resolves.toBe('none')
  })

  it('returns unknown when gh itself fails (no network, unauthenticated)', async () => {
    execaMock.mockResolvedValue({ stdout: '', exitCode: 1 } as never)
    await expect(adapter.prVerdictForBranch('/repo', 'feat/anything')).resolves.toBe('unknown')
  })

  it('returns unknown on unparseable output, rather than guessing', async () => {
    execaMock.mockResolvedValue({ stdout: 'not json', exitCode: 0 } as never)
    await expect(adapter.prVerdictForBranch('/repo', 'feat/anything')).resolves.toBe('unknown')
  })

  it('returns unknown when gh returns something other than a JSON array', async () => {
    execaMock.mockResolvedValue({ stdout: '{"not":"an array"}', exitCode: 0 } as never)
    await expect(adapter.prVerdictForBranch('/repo', 'feat/anything')).resolves.toBe('unknown')
  })
})
