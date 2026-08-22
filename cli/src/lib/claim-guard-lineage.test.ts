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
 * The second half of this file is the CASE MATRIX for the hole an independent
 * prosecution found in the first attempt at that fix: `branch_is_absorbed`
 * asked "does the candidate carry any work this push does not already have?",
 * which is VACUOUSLY TRUE of a candidate with no commits of its own. A rival
 * branch staked at `dev`'s tip — the shape AGENTS.md itself asks for, "push
 * your branch as soon as it exists" — was therefore discounted and announced
 * as "a superseded predecessor", at exit 0, while `origin/dev`'s own claim.sh
 * blocked it. Every case below is derived from a real branch shape in this
 * estate rather than invented: a pre-code reservation, the symmetric
 * seconds-apart race of 2026-08-03, a cherry-pick, a revert, a force-push.
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

/**
 * A candidate with no commits of its own is a RESERVATION, not a supersession.
 *
 * "Every commit on it is already carried by my branch" is trivially true of a
 * branch that has no commits, so the content test discounted the most ordinary
 * rival there is and called it a predecessor. These are the must-BLOCK rows;
 * the two must-ALLOW rows (the rebased predecessor, above; the declared
 * residual gap, below) are what stop the fix from being a revert of the bug it
 * was written for.
 */
describe('claim.sh --guard: a commitless candidate is a reservation, not a predecessor', () => {
  /** My branch, with real work on it, ready to push. */
  function withMyWork(): Fixture {
    const fx = makeFixture()
    fx.git(fx.work, 'checkout', '-q', '-b', 'fix/1050-mine')
    commit(fx, 'a.txt', 'one\n')
    commit(fx, 'b.txt', 'two\n')
    return fx
  }

  it('BLOCKS a rival staked at the integration tip before writing any code', () => {
    // AGENTS.md: "Push your branch as soon as it exists. The claim is a
    // reservation; the branch is the evidence." An agent following that to the
    // letter produces exactly this branch — and the first attempt discounted
    // it, printing `discounted fix/1050-other-agent` at exit 0.
    const fx = withMyWork()
    fx.git(fx.work, 'push', '-q', 'origin', 'dev:refs/heads/fix/1050-other-agent')

    const { code, out } = guard(fx, 'fix/1050-mine')
    expect(code, out).toBe(1)
    expect(out).toContain('fix/1050-other-agent')
    expect(out).not.toContain('discounted')
  })

  it("BLOCKS a rival staked at the pushing branch's own tip", () => {
    // The other direction of the same hole: the candidate is not merely
    // reachable from this push, it IS this push. Nothing to supersede.
    const fx = withMyWork()
    fx.git(fx.work, 'push', '-q', 'origin', 'fix/1050-mine:refs/heads/fix/1050-other-agent')

    const { code, out } = guard(fx, 'fix/1050-mine')
    expect(code, out).toBe(1)
    expect(out).toContain('fix/1050-other-agent')
    expect(out).not.toContain('discounted')
  })

  it('BLOCKS the symmetric race — two sessions staking one issue seconds apart', () => {
    // Both branches sit at the integration tip, so a discount granted on
    // content alone is granted to BOTH and neither blocks the other. That is
    // the 2026-08-03 collision shape, reintroduced by the first attempt.
    const fx = makeFixture()
    fx.git(fx.work, 'push', '-q', 'origin', 'dev:refs/heads/fix/1050-other-agent')
    fx.git(fx.work, 'checkout', '-q', '-b', 'fix/1050-mine')

    const { code, out } = guard(fx, 'fix/1050-mine')
    expect(code, out).toBe(1)
    expect(out).toContain('fix/1050-other-agent')
  })

  it('BLOCKS a rival left at an OLDER ancestor of the branch being pushed', () => {
    // Not only the tip: any commit already reachable from this push carries
    // nothing of its own. Counting "own commits" against the pushing branch
    // rather than against `dev` is what makes this row fall out for free.
    const fx = makeFixture()
    const base = fx.git(fx.work, 'rev-parse', 'HEAD')
    commit(fx, 'moved.txt', 'dev moves on\n')
    fx.git(fx.work, 'push', '-q', 'origin', 'dev')
    fx.git(fx.work, 'checkout', '-q', '-b', 'fix/1050-mine')
    commit(fx, 'a.txt', 'one\n')
    fx.git(fx.work, 'push', '-q', 'origin', `${base}:refs/heads/fix/1050-other-agent`)

    const { code, out } = guard(fx, 'fix/1050-mine')
    expect(code, out).toBe(1)
    expect(out).toContain('fix/1050-other-agent')
  })

  it('BLOCKS a rival that cherry-picked this work AND added its own', () => {
    const fx = withMyWork()
    fx.git(fx.work, 'checkout', '-q', '-b', 'fix/1050-other-agent', 'dev')
    fx.git(fx.work, 'cherry-pick', '--no-edit', 'fix/1050-mine~1', 'fix/1050-mine')
    commit(fx, 'rival.txt', 'theirs\n')
    fx.git(fx.work, 'push', '-q', 'origin', 'fix/1050-other-agent')
    fx.git(fx.work, 'checkout', '-q', 'fix/1050-mine')
    fx.git(fx.work, 'branch', '-D', 'fix/1050-other-agent')

    const { code, out } = guard(fx, 'fix/1050-mine')
    expect(code, out).toBe(1)
    expect(out).toContain('fix/1050-other-agent')
  })

  it('BLOCKS a rival whose own commits REVERT this work — an inverse patch id is not an equivalent one', () => {
    const fx = withMyWork()
    fx.git(fx.work, 'checkout', '-q', '-b', 'fix/1050-other-agent')
    fx.git(fx.work, 'revert', '--no-edit', 'HEAD')
    fx.git(fx.work, 'push', '-q', 'origin', 'fix/1050-other-agent')
    fx.git(fx.work, 'checkout', '-q', 'fix/1050-mine')
    fx.git(fx.work, 'branch', '-D', 'fix/1050-other-agent')

    const { code, out } = guard(fx, 'fix/1050-mine')
    expect(code, out).toBe(1)
    expect(out).toContain('fix/1050-other-agent')
  })

  it('BLOCKS a rival that force-pushed to a commit this clone has never fetched', () => {
    // `ls-remote` reports the NEW sha; this clone holds only the old one. The
    // objects check must read the sha it was given, not any ref it happens to
    // have locally, or a force-push would silently reuse a stale verdict.
    const fx = withMyWork()
    const originUrl = fx.git(fx.work, 'remote', 'get-url', 'origin')
    const rival = join(makeTmpDir('claimlineage-rival'), 'clone')
    execFileSync('git', ['clone', '-q', originUrl, rival], { env: CLEAN_ENV })
    fx.git(rival, 'config', 'user.email', 'rival@example.test')
    fx.git(rival, 'config', 'user.name', 'Rival')
    fx.git(rival, 'checkout', '-q', '-b', 'fix/1050-other-agent', 'origin/dev')
    writeFileSync(join(rival, 'v1.txt'), 'v1\n')
    fx.git(rival, 'add', '-A')
    fx.git(rival, 'commit', '-qm', 'rival v1')
    fx.git(rival, 'push', '-q', 'origin', 'fix/1050-other-agent')

    // This clone sees v1 — and then never looks again.
    fx.git(fx.work, 'fetch', '-q', 'origin', 'fix/1050-other-agent')
    fx.git(fx.work, 'reset', '-q', '--hard', 'HEAD')

    fx.git(rival, 'reset', '-q', '--hard', 'origin/dev')
    writeFileSync(join(rival, 'v2.txt'), 'v2\n')
    fx.git(rival, 'add', '-A')
    fx.git(rival, 'commit', '-qm', 'rival v2')
    fx.git(rival, 'push', '-q', '--force', 'origin', 'fix/1050-other-agent')

    const v2 = fx
      .git(fx.work, 'ls-remote', '--heads', 'origin', 'fix/1050-other-agent')
      .split('\t')[0]
    let present = true
    try {
      fx.git(fx.work, 'cat-file', '-e', `${v2}^{commit}`)
    } catch {
      present = false
    }
    expect(present, 'the fixture must genuinely lack the force-pushed objects').toBe(false)

    const { code, out } = guard(fx, 'fix/1050-mine')
    expect(code, out).toBe(1)
    expect(out).toContain('fix/1050-other-agent')
  })

  it('still DISCOUNTS a rival carrying only patch-identical work — the declared residual gap', () => {
    // Executable, so the limit cannot be quietly widened or quietly forgotten.
    // A claim reserves FUTURE work and this predicate can only see PAST work,
    // so a content test cannot close this row: the rival's commits are all
    // already in hand, and nothing in the object graph distinguishes that from
    // a rebase. Declared in `branch_is_absorbed`'s header, not silent.
    // Built as INDEPENDENT commits with their own messages, not as a
    // cherry-pick: git is deterministic, so cherry-picking these two commits
    // onto the same base reproduces their exact SHAs, and the branch would
    // then be the "candidate at the pusher's tip" row above wearing a
    // disguise. That is worth stating because the first prosecution's
    // equivalent fixture was that disguise, and it is now blocked for the
    // ordinary reason rather than tolerated for this one.
    const fx = withMyWork()
    fx.git(fx.work, 'checkout', '-q', '-b', 'fix/1050-other-agent', 'dev')
    writeFileSync(join(fx.work, 'a.txt'), 'one\n')
    fx.git(fx.work, 'add', '-A')
    fx.git(fx.work, 'commit', '-qm', 'rival: the same first change')
    writeFileSync(join(fx.work, 'b.txt'), 'two\n')
    fx.git(fx.work, 'add', '-A')
    fx.git(fx.work, 'commit', '-qm', 'rival: the same second change')
    fx.git(fx.work, 'push', '-q', 'origin', 'fix/1050-other-agent')
    const cand = fx.git(fx.work, 'rev-parse', 'fix/1050-other-agent')
    fx.git(fx.work, 'checkout', '-q', 'fix/1050-mine')
    fx.git(fx.work, 'branch', '-D', 'fix/1050-other-agent')

    // Distinct commits, carrying nothing this push lacks.
    expect(cand).not.toBe(fx.git(fx.work, 'rev-parse', 'fix/1050-mine'))
    expect(fx.git(fx.work, 'rev-list', '--count', cand, '--not', 'fix/1050-mine')).toBe('2')

    const { code, out } = guard(fx, 'fix/1050-mine')
    expect(code, out).toBe(0)
    expect(out).toContain('discounted fix/1050-other-agent')
  })
})
