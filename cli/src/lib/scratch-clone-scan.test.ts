import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyScratchClones,
  findScratchCloneCandidates,
  repoNameFromRemoteUrl,
  type ScratchCloneCandidate,
  type ScratchCloneScanDeps,
} from './scratch-clone-scan.js'
import { makeTmpDir } from '../test-utils/tmp.js'
import type { PrVerdict } from '../adapters/github-cli/index.js'
import type { GitAdapter } from '../adapters/git/index.js'

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

describe('findScratchCloneCandidates — estateRoot could not be read (#1988)', () => {
  // findScratchCloneCandidates must never swallow a readdirSync failure on
  // estateRoot itself into an empty candidate list: runScratchCloneScan in
  // commands/doctor.ts documents itself as exiting non-zero exactly when the
  // scan itself could not run, and its own catch block only fires if this
  // rejects rather than resolving to []. A git stub that throws if called
  // proves the failure surfaces before any candidate is even considered.
  const unreachableGitDeps = {
    git: {
      currentBranch: async () => {
        throw new Error('must not be called: readdirSync should have thrown first')
      },
      getRemoteUrl: async () => {
        throw new Error('must not be called: readdirSync should have thrown first')
      },
    } satisfies Pick<GitAdapter, 'currentBranch' | 'getRemoteUrl'>,
  }

  it('rejects rather than returning [] for a missing estateRoot', async () => {
    const estateRoot = join(makeTmpDir('biffo-scratch-missing'), 'does-not-exist')
    await expect(findScratchCloneCandidates(estateRoot, unreachableGitDeps)).rejects.toThrow()
  })

  it('rejects rather than returning [] for an estateRoot that is a file, not a directory', async () => {
    const dir = makeTmpDir('biffo-scratch-notdir')
    const filePath = join(dir, 'im-a-file.txt')
    writeFileSync(filePath, 'not a directory\n')
    await expect(findScratchCloneCandidates(filePath, unreachableGitDeps)).rejects.toThrow()
  })
})

describe('findScratchCloneCandidates — a malformed .git directory (#1990)', () => {
  // Matches #1990's own repro exactly: `mkdir -p estate/broken-git/.git`
  // leaves a `.git` DIRECTORY (so `isPlainCloneDir` accepts it as a
  // candidate) that git itself cannot resolve — no HEAD, no refs, no
  // objects. The real `GitAdapter.currentBranch` shells out to `git
  // rev-parse --abbrev-ref HEAD` and throws (`fatal: not a git repository`)
  // for exactly this shape; this stub reproduces that behaviour without a
  // real git subprocess, matched by path the same way #1988's own
  // `unreachableGitDeps` stub is.
  function gitStub(brokenPaths: Set<string>) {
    const getRemoteUrlCalls: string[] = []
    return {
      getRemoteUrlCalls,
      git: {
        currentBranch: async (path: string) => {
          if (brokenPaths.has(path)) {
            throw new Error('fatal: not a git repository (or any parent up to mount point /)')
          }
          return 'dev'
        },
        getRemoteUrl: async (path: string) => {
          getRemoteUrlCalls.push(path)
          return ''
        },
      } satisfies ScratchCloneScanDeps['git'],
    }
  }

  it('reports every OTHER real candidate rather than aborting the whole scan on one malformed .git', async () => {
    const estateRoot = makeTmpDir('biffo-scratch-broken-git')
    const brokenDir = join(estateRoot, 'broken-git')
    const goodDir = join(estateRoot, 'good-clone')
    mkdirSync(join(brokenDir, '.git'), { recursive: true })
    mkdirSync(join(goodDir, '.git'), { recursive: true })

    const { git, getRemoteUrlCalls } = gitStub(new Set([brokenDir]))
    const candidates = await findScratchCloneCandidates(estateRoot, { git })

    expect(candidates).toHaveLength(2)
    const broken = candidates.find((c) => c.path === brokenDir)
    const good = candidates.find((c) => c.path === goodDir)
    expect(broken).toEqual({ path: brokenDir, branch: '', invalidRepo: true })
    expect(good).toEqual({ path: goodDir, branch: 'dev' })
    // A repo git could not even find a branch for has nothing worth asking
    // `getRemoteUrl` about — proves the malformed candidate is excluded from
    // the rest of the per-candidate work, not merely tolerated by it.
    expect(getRemoteUrlCalls).toEqual([goodDir])
  })

  it('classifyScratchClones keeps an invalid-repo candidate with its own reason, calling no git/GitHub method at all', async () => {
    const unreachable = {
      hasUncommittedChanges: async () => {
        throw new Error('must not be called: invalidRepo must short-circuit first')
      },
      headSha: async () => {
        throw new Error('must not be called: invalidRepo must short-circuit first')
      },
      isAncestor: async () => {
        throw new Error('must not be called: invalidRepo must short-circuit first')
      },
    }
    const unreachableGithub = {
      prVerdictForBranch: async () => {
        throw new Error('must not be called: invalidRepo must short-circuit first')
      },
      mergedHeadSha: async () => {
        throw new Error('must not be called: invalidRepo must short-circuit first')
      },
    }

    const [report] = await classifyScratchClones(
      [{ path: '/estate/broken-git', branch: '', invalidRepo: true }],
      { git: unreachable, github: unreachableGithub },
    )
    expect(report?.verdict).toEqual({ action: 'keep', reason: 'not-a-git-repository' })
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
