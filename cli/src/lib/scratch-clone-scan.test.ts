import { describe, expect, it } from 'vitest'
import {
  classifyScratchClones,
  repoNameFromRemoteUrl,
  type ScratchCloneCandidate,
} from './scratch-clone-scan.js'
import type { PrVerdict } from '../adapters/github-cli/index.js'

describe('repoNameFromRemoteUrl (#1949)', () => {
  // Corpus-grounded must-catch / must-NOT-catch table — every URL shape a
  // real `git remote get-url origin` in this estate actually returns.

  it('reads the repo name from an SSH remote', () => {
    expect(repoNameFromRemoteUrl('git@github.com:keiranholloway/biffo-template.git')).toBe(
      'biffo-template',
    )
  })

  it('reads the repo name from an HTTPS remote', () => {
    expect(repoNameFromRemoteUrl('https://github.com/tabsii-com/tabsii-crm.git')).toBe('tabsii-crm')
  })

  it('reads the repo name when the URL has no trailing .git', () => {
    expect(repoNameFromRemoteUrl('https://github.com/tabsii-com/tabsii-platform')).toBe(
      'tabsii-platform',
    )
  })

  it('reads the repo name past a trailing slash', () => {
    expect(repoNameFromRemoteUrl('https://github.com/keiranholloway/biffo-fleet/')).toBe(
      'biffo-fleet',
    )
  })

  it('reads a local filesystem path remote (what `git clone <path>` sets as origin)', () => {
    expect(repoNameFromRemoteUrl('/home/keiran/code/biffo-template')).toBe('biffo-template')
  })

  it('returns null for an empty remote', () => {
    expect(repoNameFromRemoteUrl('')).toBeNull()
    expect(repoNameFromRemoteUrl('   ')).toBeNull()
  })
})

describe('classifyScratchClones (#1949)', () => {
  function candidate(overrides: Partial<ScratchCloneCandidate> = {}): ScratchCloneCandidate {
    return { path: '/estate/scratch-1234', branch: 'fix/some-thing', ...overrides }
  }

  /** A deps stub recording every cwd it was called with, so tests can prove
   * GitHub is asked about the CANDIDATE's own repo, never the invoking one. */
  function deps(opts: {
    isDirty?: boolean
    prVerdict?: PrVerdict
    mergedHeadSha?: string | null
    headSha?: string | null
    isAncestor?: boolean | null
  }) {
    const calls: { fn: string; cwd: string }[] = []
    return {
      calls,
      deps: {
        git: {
          hasUncommittedChanges: async (cwd: string) => {
            calls.push({ fn: 'hasUncommittedChanges', cwd })
            return opts.isDirty ?? false
          },
          headSha: async (cwd: string) => {
            calls.push({ fn: 'headSha', cwd })
            return opts.headSha ?? 'aaaaaaa'
          },
          isAncestor: async (cwd: string) => {
            calls.push({ fn: 'isAncestor', cwd })
            return opts.isAncestor ?? true
          },
        },
        github: {
          prVerdictForBranch: async (cwd: string) => {
            calls.push({ fn: 'prVerdictForBranch', cwd })
            return opts.prVerdict ?? 'merged'
          },
          mergedHeadSha: async (cwd: string) => {
            calls.push({ fn: 'mergedHeadSha', cwd })
            return opts.mergedHeadSha ?? 'aaaaaaa'
          },
        },
      },
    }
  }

  it('reaps a clean clone whose branch PR merged and whose HEAD is contained in what merged', async () => {
    const { deps: d } = deps({ prVerdict: 'merged', headSha: 'aaa', mergedHeadSha: 'aaa' })
    const [report] = await classifyScratchClones([candidate()], d)
    expect(report?.verdict).toEqual({ action: 'reap' })
  })

  it('keeps a clone with uncommitted changes, never asking GitHub at all', async () => {
    const { deps: d, calls } = deps({ isDirty: true })
    const [report] = await classifyScratchClones([candidate()], d)
    expect(report?.verdict).toEqual({ action: 'keep', reason: 'uncommitted-changes' })
    expect(calls.some((c) => c.fn === 'prVerdictForBranch')).toBe(false)
  })

  it('keeps a detached-HEAD clone, never asking GitHub at all', async () => {
    const { deps: d, calls } = deps({})
    const [report] = await classifyScratchClones([candidate({ branch: 'HEAD' })], d)
    expect(report?.verdict).toEqual({ action: 'keep', reason: 'detached-head' })
    expect(calls.some((c) => c.fn === 'prVerdictForBranch')).toBe(false)
  })

  it('keeps a clone whose branch PR is still open', async () => {
    const { deps: d } = deps({ prVerdict: 'open' })
    const [report] = await classifyScratchClones([candidate()], d)
    expect(report?.verdict).toEqual({ action: 'keep', reason: 'pr-open' })
  })

  it('keeps a clone whose branch never had a PR (the "clean mirror of dev" shape)', async () => {
    const { deps: d } = deps({ prVerdict: 'none' })
    const [report] = await classifyScratchClones([candidate({ branch: 'dev' })], d)
    expect(report?.verdict).toEqual({ action: 'keep', reason: 'no-pr' })
  })

  it('keeps a clone whose merged PR head could not be confirmed as an ancestor of HEAD (#1810)', async () => {
    const { deps: d } = deps({
      prVerdict: 'merged',
      headSha: 'bbb',
      mergedHeadSha: 'aaa',
      isAncestor: false,
    })
    const [report] = await classifyScratchClones([candidate()], d)
    expect(report?.verdict).toEqual({ action: 'keep', reason: 'commits-not-in-merge' })
  })

  it("asks GitHub about the CANDIDATE's own path, not some other cwd", async () => {
    const { deps: d, calls } = deps({ prVerdict: 'merged' })
    await classifyScratchClones([candidate({ path: '/estate/scratch-9999' })], d)
    expect(calls.every((c) => c.cwd === '/estate/scratch-9999')).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
  })
})
