import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `scripts/claim.sh --guard` compared ISSUE NUMBERS, and a number has no
 * lineage — so it could not tell a genuine RIVAL CLAIMANT from the pusher's own
 * SUPERSEDED PREDECESSOR, the branch they abandoned and rebased away from.
 * Measured live on tabsii-platform: `fix/1050-1033-1061-upstream-carry` is
 * still on the remote at 5b1b8977 while its successor
 * `fix/1050-1033-1061-carry-rebased` was auto-deleted on merge, so every future
 * push naming 1050 is refused by a dead branch
 * (tabsii-com/tabsii-platform#1112).
 *
 * These tests use a REAL git repository with a REAL `file://` remote rather
 * than a stubbed `git`, because the whole fix is a claim about the object
 * graph: `git cherry`'s patch-id equivalence, `git rev-list --merges`, and
 * whether an object is present in this clone at all. A stub could only restate
 * the answer the assertion is checking.
 *
 * `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` are stripped from every child's
 * environment. git EXPORTS those into hooks, and this suite can be run from
 * `.husky/pre-push`; leaving them set would make every `git` call below operate
 * on the REAL repository instead of the fixture — the shape that once made a
 * test fixture commit and push to a live remote.
 */
const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'claim.sh')

const CLEAN_ENV: NodeJS.ProcessEnv = { ...process.env }
delete CLEAN_ENV['GIT_DIR']
delete CLEAN_ENV['GIT_WORK_TREE']
delete CLEAN_ENV['GIT_INDEX_FILE']

/**
 * Drop ANSI colour so assertions read the words, not the escapes. The pattern
 * is built at runtime because ESLint's `no-control-regex` refuses an ESC in a
 * regex LITERAL — including as `\u001b` — and a disable comment would suppress
 * the rule rather than avoid the construct it is about.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const strip = (s: string) => s.replace(ANSI, '')

interface Fixture {
  /** The working clone the guard runs in. */
  work: string
  /** Directory holding the `gh` stub, prepended to PATH. */
  stub: string
  git: (cwd: string, ...args: string[]) => string
}

/**
 * A `gh` that answers only what the guard asks, and reports no open PRs — so
 * every outcome below is attributable to the BRANCH signal under test.
 */
function ghStub(dir: string): string {
  const stub = join(dir, 'stub')
  mkdirSync(stub)
  writeFileSync(
    join(stub, 'gh'),
    [
      '#!/usr/bin/env sh',
      'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo "owner/repo"; exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then exit 0; fi',
      'echo "stub gh: unhandled: $*" >&2; exit 1',
      '',
    ].join('\n'),
  )
  chmodSync(join(stub, 'gh'), 0o755)
  return stub
}

/**
 * A bare origin plus a working clone, with `dev` carrying one commit.
 *
 * The remote is addressed as a `file://` URL deliberately: a plain local-path
 * clone shares the origin's object store by hardlink, so `--single-branch`
 * would still leave every other branch's objects readable and the
 * "objects absent from this clone" case could not be built at all.
 */
function makeFixture(): Fixture {
  const dir = makeTmpDir('claimlineage')
  const origin = join(dir, 'origin.git')
  const work = join(dir, 'work')

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: CLEAN_ENV }).trim()

  execFileSync('git', ['init', '-q', '--bare', origin], { env: CLEAN_ENV })
  mkdirSync(work)
  git(work, 'init', '-q', '-b', 'dev')
  git(work, 'config', 'user.email', 'fixture@example.test')
  git(work, 'config', 'user.name', 'Fixture')
  git(work, 'remote', 'add', 'origin', `file://${origin}`)
  writeFileSync(join(work, 'base.txt'), 'base\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-qm', 'base')
  git(work, 'push', '-q', 'origin', 'dev')

  return { work, stub: ghStub(dir), git }
}

function commit(fx: Fixture, name: string, body: string): void {
  writeFileSync(join(fx.work, name), body)
  fx.git(fx.work, 'add', '-A')
  fx.git(fx.work, 'commit', '-qm', `add ${name}`)
}

/** Run the real `claim.sh --guard <branch>` inside a fixture clone. */
function guard(fx: Fixture, branch: string, cwd = fx.work) {
  const env = { ...CLEAN_ENV, PATH: `${fx.stub}:${CLEAN_ENV['PATH'] ?? ''}` }
  // `spawnSync`, not `execFileSync`: the discount notice is written to STDERR
  // (it is advisory output from a git hook), and `execFileSync` returns only
  // stdout on success — so the exit-0 case would assert against an empty
  // string and pass for the wrong reason.
  const r = spawnSync('sh', [script, '--guard', branch], { cwd, encoding: 'utf8', env })
  return { code: r.status ?? -1, out: strip((r.stdout ?? '') + (r.stderr ?? '')) }
}

/**
 * The reported shape: work is pushed on one branch, `dev` moves on, the work is
 * REBASED onto it under a new name, and the old branch is left on the remote.
 * Returns the fixture with `fix/1050-carry-rebased` checked out.
 */
function withRebasedPredecessor(): Fixture {
  const fx = makeFixture()
  fx.git(fx.work, 'checkout', '-q', '-b', 'fix/1050-upstream-carry')
  commit(fx, 'a.txt', 'one\n')
  commit(fx, 'b.txt', 'two\n')
  fx.git(fx.work, 'push', '-q', 'origin', 'fix/1050-upstream-carry')

  fx.git(fx.work, 'checkout', '-q', 'dev')
  commit(fx, 'moved.txt', 'dev moves on\n')
  fx.git(fx.work, 'push', '-q', 'origin', 'dev')

  fx.git(fx.work, 'checkout', '-q', '-b', 'fix/1050-carry-rebased', 'fix/1050-upstream-carry')
  fx.git(fx.work, 'rebase', '-q', 'dev')
  return fx
}

/** A second session's live branch on the same issue, carrying different work. */
function addRival(fx: Fixture, branch: string, file: string): void {
  const current = fx.git(fx.work, 'symbolic-ref', '--short', 'HEAD')
  fx.git(fx.work, 'checkout', '-q', '-b', branch, 'dev')
  commit(fx, file, 'another session\n')
  fx.git(fx.work, 'push', '-q', 'origin', branch)
  fx.git(fx.work, 'checkout', '-q', current)
  fx.git(fx.work, 'branch', '-D', branch)
}

describe('claim.sh --guard lineage (tabsii-com/tabsii-platform#1112)', () => {
  it('a rebase breaks ancestry, so `merge-base --is-ancestor` cannot be the primitive', () => {
    // Recorded as a test rather than as prose because the whole design rests on
    // it: the predecessor is NOT an ancestor of its own rebased successor, yet
    // every one of its commits has a patch-id equivalent there.
    const fx = withRebasedPredecessor()
    let isAncestor = true
    try {
      fx.git(fx.work, 'merge-base', '--is-ancestor', 'fix/1050-upstream-carry', 'HEAD')
    } catch {
      isAncestor = false
    }
    expect(isAncestor).toBe(false)

    const cherry = fx.git(fx.work, 'cherry', 'HEAD', 'fix/1050-upstream-carry')
    expect(cherry.split('\n')).toHaveLength(2)
    expect(cherry).not.toMatch(/^\+/m)
  })

  it('ALLOWS the push, and says so, when the only other branch is its own superseded predecessor', () => {
    const fx = withRebasedPredecessor()
    const { code, out } = guard(fx, 'fix/1050-carry-rebased')

    expect(code, out).toBe(0)
    expect(out).not.toContain('claimed by someone else')
    // A discount a guard grants silently is a guard nobody can audit.
    expect(out).toContain('discounted fix/1050-upstream-carry')
  })

  it('STILL BLOCKS a genuine rival claimant while discounting the predecessor', () => {
    // The case that matters: a change passing the first two and failing this
    // one has not fixed the guard, it has disabled it.
    const fx = withRebasedPredecessor()
    addRival(fx, 'fix/1050-other-agent', 'rival.txt')

    const { code, out } = guard(fx, 'fix/1050-carry-rebased')

    expect(code, out).toBe(1)
    expect(out).toContain('claimed by someone else')
    expect(out).toContain('fix/1050-other-agent')
    // The predecessor is discounted, and never presented as the conflict.
    expect(out).not.toMatch(/branch {2,}fix\/1050-upstream-carry/)
  })

  it('BLOCKS a rival whose objects this clone has never fetched — absence of evidence is not supersession', () => {
    const fx = withRebasedPredecessor()
    addRival(fx, 'fix/1050-other-agent', 'rival.txt')

    // A clone that carries `dev` and the predecessor, and has never seen the
    // rival's commits. `branch_is_absorbed` cannot evaluate what it cannot
    // read, and must therefore refuse.
    const origin = fx.git(fx.work, 'remote', 'get-url', 'origin')
    const fresh = join(makeTmpDir('claimlineage-fresh'), 'clone')
    execFileSync('git', ['clone', '-q', '--single-branch', '--branch', 'dev', origin, fresh], {
      env: CLEAN_ENV,
    })
    fx.git(fresh, 'config', 'user.email', 'fixture@example.test')
    fx.git(fresh, 'config', 'user.name', 'Fixture')
    fx.git(
      fresh,
      'fetch',
      '-q',
      'origin',
      'fix/1050-upstream-carry:refs/remotes/origin/fix/1050-upstream-carry',
    )
    fx.git(
      fresh,
      'checkout',
      '-q',
      '-b',
      'fix/1050-carry-rebased',
      'origin/fix/1050-upstream-carry',
    )
    fx.git(fresh, 'rebase', '-q', 'origin/dev')

    const rivalSha = fx
      .git(fresh, 'ls-remote', '--heads', 'origin', 'fix/1050-other-agent')
      .split('\t')[0]
    let present = true
    try {
      fx.git(fresh, 'cat-file', '-e', `${rivalSha}^{commit}`)
    } catch {
      present = false
    }
    expect(present, 'the fixture must genuinely lack the rival objects').toBe(false)

    const { code, out } = guard(fx, 'fix/1050-carry-rebased', fresh)
    expect(code, out).toBe(1)
    expect(out).toContain('fix/1050-other-agent')
  })

  it('BLOCKS when the predecessor was SQUASHED rather than replayed — a declared false positive', () => {
    // Conservative on purpose: squashing changes every patch id, so the guard
    // cannot demonstrate supersession and does not pretend to.
    const fx = makeFixture()
    fx.git(fx.work, 'checkout', '-q', '-b', 'fix/2001-pred')
    commit(fx, 'a.txt', 'one\n')
    commit(fx, 'b.txt', 'two\n')
    fx.git(fx.work, 'push', '-q', 'origin', 'fix/2001-pred')
    fx.git(fx.work, 'checkout', '-q', 'dev')
    commit(fx, 'moved.txt', 'dev moves on\n')
    fx.git(fx.work, 'checkout', '-q', '-b', 'fix/2001-squashed', 'dev')
    fx.git(fx.work, 'merge', '-q', '--squash', 'fix/2001-pred')
    fx.git(fx.work, 'commit', '-qm', 'squashed one+two')

    const { code, out } = guard(fx, 'fix/2001-squashed')
    expect(code, out).toBe(1)
    expect(out).toContain('fix/2001-pred')
  })

  it('BLOCKS a candidate carrying an unmerged MERGE commit, which `git cherry` cannot see', () => {
    // `git cherry` compares NON-MERGE commits only. A candidate whose every
    // non-merge commit is equivalent still reads as fully absorbed, while an
    // evil merge's own resolution is invisible to it — so the merge count is
    // checked separately and refuses rather than guesses.
    const fx = makeFixture()
    fx.git(fx.work, 'checkout', '-q', '-b', 'fix/2002-side')
    commit(fx, 'x.txt', 'x\n')
    fx.git(fx.work, 'checkout', '-q', '-b', 'fix/2002-withmerge', 'dev')
    fx.git(fx.work, 'merge', '-q', '--no-ff', '-m', 'merge in side', 'fix/2002-side')
    fx.git(fx.work, 'push', '-q', 'origin', 'fix/2002-withmerge')
    fx.git(fx.work, 'checkout', '-q', '-b', 'fix/2002-mine', 'fix/2002-side')
    fx.git(fx.work, 'branch', '-D', 'fix/2002-side')

    // The blind spot, demonstrated rather than asserted: cherry sees nothing
    // that is not already carried, yet a merge commit is unaccounted for.
    expect(fx.git(fx.work, 'cherry', 'fix/2002-mine', 'fix/2002-withmerge')).not.toMatch(/^\+/m)
    expect(
      fx.git(
        fx.work,
        'rev-list',
        '--merges',
        '--count',
        'fix/2002-withmerge',
        '--not',
        'fix/2002-mine',
      ),
    ).toBe('1')

    const { code, out } = guard(fx, 'fix/2002-mine')
    expect(code, out).toBe(1)
    expect(out).toContain('fix/2002-withmerge')
  })

  it('is still portable — parses under sh, dash and bash', () => {
    for (const sh of ['sh', 'dash', 'bash']) {
      expect(() => execFileSync(sh, ['-n', script])).not.toThrow()
    }
  })
})
