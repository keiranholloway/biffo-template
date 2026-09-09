import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitAdapter } from './index.js'
import { makeTmpDir } from '../../test-utils/tmp.js'
import {
  classifyScratchClones,
  findScratchCloneCandidates,
  type ScratchCloneClassifyDeps,
} from '../../lib/scratch-clone-scan.js'

/**
 * `findScratchCloneCandidates` / `classifyScratchClones` (#1949), driven
 * against real repos rather than mocked git — the whole defect is that a
 * plain `git clone` directory is invisible to `git worktree list`, which is
 * only true or false against a real `.git`, not a fake.
 *
 * The GitHub half is faked (there is no live PR to ask about for a
 * disposable local repo), same pattern as `doctor-reaper.integration.test.ts`.
 */
describe('scratch-clone-scan against real git (#1949)', () => {
  let estate: string
  let realRepo: string
  const adapter = new GitAdapter()

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  beforeEach(() => {
    estate = makeTmpDir('biffo-scratch-estate')
    realRepo = join(estate, 'real-repo')
    mkdirSync(realRepo, { recursive: true })
    git(realRepo, 'init', '-q', '-b', 'dev')
    git(realRepo, 'config', 'user.email', 'test@example.com')
    git(realRepo, 'config', 'user.name', 'Test')
    writeFileSync(join(realRepo, 'a.txt'), 'base\n')
    git(realRepo, 'add', '-A')
    git(realRepo, 'commit', '-qm', 'base')
    // A real primary checkout has an `origin` remote naming itself — needed
    // for the "known repo" name-match signal to have anything to compare
    // against. `git init` alone (unlike `git clone`) sets none.
    git(realRepo, 'remote', 'add', 'origin', 'git@github.com:keiranholloway/real-repo.git')
    // A linked worktree of the real repo — this IS visible to `git worktree
    // list` and must never show up as a scratch-clone candidate.
    git(realRepo, 'worktree', 'add', join(realRepo, '.worktrees', 'feature'), '-b', 'feat/thing')
  })

  afterEach(() => {
    rmSync(estate, { recursive: true, force: true })
  })

  it('FAIL-FIRST: a plain clone sitting beside a real repo is invisible to git worktree list', () => {
    const scratchDir = join(estate, 'prosecute-1234')
    git(estate, 'clone', '-q', realRepo, scratchDir)
    git(scratchDir, 'checkout', '-qb', 'review/pr-77')

    // This is exactly what every existing doctor check (`gatherRepoFacts` /
    // `runDoctorFix`) starts from. It walks ONE repo's own worktree list —
    // a sibling plain clone never appears in it, by construction.
    const worktreeListing = git(realRepo, 'worktree', 'list', '--porcelain')
    expect(worktreeListing).not.toContain('prosecute-1234')
  })

  it('finds a plain clone under the estate root as a candidate, ignoring the real repo and its worktree', async () => {
    const scratchDir = join(estate, 'prosecute-1234')
    git(estate, 'clone', '-q', realRepo, scratchDir)
    git(scratchDir, 'checkout', '-qb', 'review/pr-77')

    const candidates = await findScratchCloneCandidates(estate, { git: adapter })
    const paths = candidates.map((c) => c.path)

    expect(paths).toContain(scratchDir)
    expect(paths).not.toContain(realRepo)
    // The linked worktree is nested (not top-level under `estate`) AND its
    // `.git` is a pointer FILE, not a directory — excluded on both counts.
    expect(paths.some((p) => p.includes('.worktrees'))).toBe(false)
  })

  it('excludes a clone that both matches its repo name AND sits on the integration branch', async () => {
    // A second, legitimately-named clone of the same repo, left on `dev` —
    // exactly the shape of someone's real ongoing checkout.
    const namedLikeRealRepo = join(estate, 'real-repo')
    // (already created in beforeEach as the primary — reuse it directly)
    const candidates = await findScratchCloneCandidates(estate, { git: adapter })
    expect(candidates.map((c) => c.path)).not.toContain(namedLikeRealRepo)
  })

  it('does NOT exclude a clone on dev whose directory is named for a task, not the repo (the "clean mirror of dev" shape)', async () => {
    const mirrorDir = join(estate, 'scratch-explore')
    git(estate, 'clone', '-q', realRepo, mirrorDir)
    // Cloning checks out `dev` by default already; nothing further to do.

    const candidates = await findScratchCloneCandidates(estate, { git: adapter })
    expect(candidates.map((c) => c.path)).toContain(mirrorDir)
  })

  it('classifies a reviewed-and-merged scratch clone as reapable, using the real HEAD/ancestor check', async () => {
    const scratchDir = join(estate, 'prosecute-1234')
    git(estate, 'clone', '-q', realRepo, scratchDir)
    git(scratchDir, 'checkout', '-qb', 'review/pr-77')
    const headSha = git(scratchDir, 'rev-parse', 'HEAD')

    const githubStub: ScratchCloneClassifyDeps['github'] = {
      prVerdictForBranch: async () => 'merged',
      mergedHeadSha: async () => headSha,
    }

    const [report] = await classifyScratchClones([{ path: scratchDir, branch: 'review/pr-77' }], {
      git: adapter,
      github: githubStub,
    })
    expect(report?.verdict).toEqual({ action: 'reap' })
  })

  it('does not abort the whole scan on a malformed .git directory, and still reports every other real candidate (#1990)', async () => {
    // Exact repro from #1990: `mkdir -p estate/broken-git/.git` — a `.git`
    // DIRECTORY (so `isPlainCloneDir` accepts it as a candidate, same as a
    // real clone) that is not, and was never, an initialised git repository.
    // No `git init` ever ran inside it, unlike every other directory in this
    // suite's `beforeEach`.
    const brokenDir = join(estate, 'broken-git')
    mkdirSync(join(brokenDir, '.git'), { recursive: true })

    // A real, ordinary scratch clone alongside it — this is the candidate
    // that a caught-but-unhandled exception on `broken-git` would silently
    // discard if the fix only suppressed the error rather than isolating it
    // per-candidate.
    const scratchDir = join(estate, 'prosecute-1234')
    git(estate, 'clone', '-q', realRepo, scratchDir)
    git(scratchDir, 'checkout', '-qb', 'review/pr-77')

    const candidates = await findScratchCloneCandidates(estate, { git: adapter })
    const paths = candidates.map((c) => c.path)
    expect(paths).toContain(brokenDir)
    expect(paths).toContain(scratchDir)

    const broken = candidates.find((c) => c.path === brokenDir)
    expect(broken).toEqual({ path: brokenDir, branch: '', invalidRepo: true })

    const githubStub: ScratchCloneClassifyDeps['github'] = {
      prVerdictForBranch: async () => 'merged',
      mergedHeadSha: async () => git(scratchDir, 'rev-parse', 'HEAD'),
    }
    const reports = await classifyScratchClones(candidates, { git: adapter, github: githubStub })

    const brokenReport = reports.find((r) => r.candidate.path === brokenDir)
    expect(brokenReport?.verdict).toEqual({ action: 'keep', reason: 'not-a-git-repository' })

    // The real candidate beside it is still fully classified — the scan
    // completed rather than throwing out of the loop on `broken-git`.
    const scratchReport = reports.find((r) => r.candidate.path === scratchDir)
    expect(scratchReport?.verdict).toEqual({ action: 'reap' })
  })

  it('keeps a scratch clone with uncommitted changes rather than proposing it for removal', async () => {
    const scratchDir = join(estate, 'prosecute-5678')
    git(estate, 'clone', '-q', realRepo, scratchDir)
    git(scratchDir, 'checkout', '-qb', 'review/pr-88')
    writeFileSync(join(scratchDir, 'a.txt'), 'dirty\n')

    const githubStub: ScratchCloneClassifyDeps['github'] = {
      prVerdictForBranch: async () => {
        throw new Error('must not be called for a dirty candidate')
      },
      mergedHeadSha: async () => null,
    }

    const [report] = await classifyScratchClones([{ path: scratchDir, branch: 'review/pr-88' }], {
      git: adapter,
      github: githubStub,
    })
    expect(report?.verdict).toEqual({ action: 'keep', reason: 'uncommitted-changes' })
  })
})
