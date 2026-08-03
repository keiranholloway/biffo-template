import { execaSync } from 'execa'
import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { resolveReleaseSubject } from './check-release-subject.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * How the release-subject guard obtains the title it judges (#1187).
 *
 * ## Why this is not a detail
 *
 * The guard's only remedy is "retitle the PR". While the title came from
 * `github.event.pull_request.title` that remedy could not work: the payload is
 * frozen when the `pull_request` event fires, `on: pull_request` declares no
 * `types:` so `edited` is not among the defaults, and a job re-run replays the
 * original payload. A correctly retitled PR stayed red until its author pushed
 * an unrelated commit.
 *
 * This is the second instance of #1174 — the closing-keywords guard had the
 * identical defect on the PR *body*, fixed in #1180 — so the resolution mirrors
 * `resolveBody` in `scripts/check-closing-keywords.mjs`, including the part
 * that matters most: **an unreadable live fetch fails, it does not fall back.**
 *
 * Falling back to the git log would be worse than the original bug. It judges
 * the last commit's subject instead of the PR title, so a token expiry or an
 * API blip would let a badly-titled PR pass because some earlier commit
 * happened to parse — shipping a feature as a patch, which is precisely what
 * the guard exists to prevent.
 */

const temps: string[] = []
function gitRepo(subject: string): string {
  const dir = makeTmpDir('biffo-relsubj')
  temps.push(dir)
  const opts = { cwd: dir } as const
  execaSync('git', ['init', '-q', '-b', 'dev'], opts)
  execaSync('git', ['config', 'user.email', 't@e.com'], opts)
  execaSync('git', ['config', 'user.name', 'T'], opts)
  execaSync('git', ['commit', '-q', '--allow-empty', '-m', subject], opts)
  return dir
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

const CREDS = { GH_TOKEN: 'tok', PR_NUMBER: '42', GH_REPO: 'o/r' }

describe('resolveReleaseSubject', () => {
  it('prefers an explicit PR_TITLE, and never touches the network for it', async () => {
    const fetchLiveTitle = vi.fn()
    const subject = await resolveReleaseSubject({
      env: { PR_TITLE: 'feat(api): explicit' },
      cwd: gitRepo('chore: head commit'),
      fetchLiveTitle,
    })

    expect(subject).toBe('feat(api): explicit')
    // The local and test path must work with no `gh` and no token.
    expect(fetchLiveTitle).not.toHaveBeenCalled()
  })

  it('fetches the title live when the CI trio is present', async () => {
    const fetchLiveTitle = vi.fn().mockResolvedValue('feat(api): the retitled value')

    const subject = await resolveReleaseSubject({
      env: { ...CREDS },
      cwd: gitRepo('chore: head commit'),
      fetchLiveTitle,
    })

    // The whole point: NOT the head commit, and not a frozen payload.
    expect(subject).toBe('feat(api): the retitled value')
    expect(fetchLiveTitle).toHaveBeenCalledWith(CREDS)
  })

  it('falls back to the head commit only when nothing else is set', async () => {
    const subject = await resolveReleaseSubject({
      env: {},
      cwd: gitRepo('fix(cli): head commit subject'),
      fetchLiveTitle: vi.fn(),
    })
    expect(subject).toBe('fix(cli): head commit subject')
  })

  /**
   * The fail-closed half. Both of these would be `class:fail-open` if they
   * resolved to a subject instead of throwing.
   */
  it('throws rather than falling back when the live fetch fails', async () => {
    const cwd = gitRepo('feat(api): a head commit that WOULD parse')
    const fetchLiveTitle = vi.fn().mockRejectedValue(new Error('gh: HTTP 401'))

    await expect(resolveReleaseSubject({ env: { ...CREDS }, cwd, fetchLiveTitle })).rejects.toThrow(
      /could not fetch the live title of PR #42 in o\/r/,
    )

    // Specifically: it must not have silently judged the head commit, which
    // parses fine and would have let a badly-titled PR through.
    await expect(resolveReleaseSubject({ env: { ...CREDS }, cwd, fetchLiveTitle })).rejects.toThrow(
      /401/,
    )
  })

  it('throws on a half-configured trio rather than treating it as "not a PR"', async () => {
    await expect(
      resolveReleaseSubject({
        env: { GH_TOKEN: 'tok', PR_NUMBER: '42' }, // GH_REPO missing
        cwd: gitRepo('chore: head'),
        fetchLiveTitle: vi.fn(),
      }),
    ).rejects.toThrow(/must all be set together/)
  })

  it('treats a whitespace-only PR_TITLE as unset rather than as an empty subject', async () => {
    const subject = await resolveReleaseSubject({
      env: { PR_TITLE: '   ' },
      cwd: gitRepo('fix(cli): head commit subject'),
      fetchLiveTitle: vi.fn(),
    })
    // An empty title must not become an empty subject that trivially fails to
    // parse — it means "not provided", so the next path applies.
    expect(subject).toBe('fix(cli): head commit subject')
  })
})
