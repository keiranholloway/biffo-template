import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * A clone that cannot be read must say so, rather than reporting every shared
 * file as missing.
 *
 * `diff_files` reads each file at `origin/<base>`, where `<base>` came from
 * `resolve_base`. That function's fallbacks can each name a branch the remote
 * does not have: `origin/HEAD` is a local symref that keeps pointing at `main`
 * after the `main` -> `dev` migration (#1145) until something re-points it, and
 * the last resort is the LOCAL checked-out branch name, which says nothing
 * about the remote.
 *
 * When the ref does not exist, `git show "origin/$base:$f"` returns empty for
 * **every** file — so a stale clone reports as fully drifted, and the operator
 * is sent to fix a repo whose files are fine. On 2026-08-02 two clones that had
 * never fetched `origin/dev` produced `push failed: cannot change to
 * .worktrees/shared-sync`: a message about a directory, for a missing ref, in a
 * run that had already opened 11 PRs.
 */
const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'shared-sync.sh')

/**
 * A satellite clone whose only remote-tracking branch is `main`, with no
 * `origin/dev` and no `origin/HEAD` — the shape a `--single-branch` clone has
 * after the estate moved its default to `dev`.
 */
function estateWithUnreadableClone(): string {
  const estate = makeTmpDir('sync-estate')

  const origin = join(estate, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])

  const seed = join(estate, 'seed')
  execFileSync('git', ['init', '-q', '-b', 'main', seed])
  writeFileSync(join(seed, 'biffo.sibling.json'), '{}\n')
  execFileSync('git', ['-C', seed, 'add', '-A'])
  execFileSync('git', [
    '-C',
    seed,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-qm',
    'seed',
  ])
  execFileSync('git', ['-C', seed, 'remote', 'add', 'origin', origin])
  execFileSync('git', ['-C', seed, 'push', '-q', 'origin', 'main'])

  // A `--single-branch` clone pins its refspec to `main`, so a later
  // `git fetch` never brings any other branch down — which is why these clones
  // survived the migration without ever seeing `origin/dev`.
  const clone = join(estate, 'satellite')
  execFileSync('git', ['clone', '-q', '--single-branch', '--branch', 'main', origin, clone])

  // The estate's `main` -> `dev` migration (#1145), from the clone's point of
  // view: the branch it tracks stops existing and the one that replaced it is
  // outside its refspec. After the `fetch --prune` that `diff_files` runs,
  // `origin/main` is gone and `origin/dev` was never fetched — so every
  // candidate `resolve_base` can name is unreachable.
  execFileSync('git', ['-C', seed, 'push', '-q', 'origin', 'main:dev'])
  // The remote's default has to move before its old default can be deleted —
  // which is exactly the order the migration ran in.
  execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/dev'])
  execFileSync('git', ['-C', seed, 'push', '-q', 'origin', '--delete', 'main'])

  return estate
}

function run(estate: string, args: string[]) {
  try {
    const stdout = execFileSync('bash', [script, '--estate', estate, ...args], {
      encoding: 'utf8',
    })
    return { code: 0, out: stdout }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

describe('shared-sync on a clone that cannot reach its remote', () => {
  it('reports the fetch failure instead of calling it drift', () => {
    const estate = estateWithUnreadableClone()
    const { out } = run(estate, ['--check', '--repo', 'satellite'])

    // Without this, `2>/dev/null` swallows `fatal: couldn't find remote ref`,
    // NOTHING is pruned, and every later read runs against the dead
    // `refs/remotes/origin/main` that survived — so the repo is reported
    // drifted on the strength of a frozen commit.
    expect(out).toContain('cannot fetch')
    expect(out).toContain("couldn't find remote ref")
    expect(out).not.toContain('DRIFTED')
  })

  it('does not claim the shared files are missing when it could not fetch', () => {
    const estate = estateWithUnreadableClone()
    const { out } = run(estate, ['--check', '--repo', 'satellite'])

    // `scripts/verify.sh(missing)` would send someone to fix file distribution
    // when the actual fix is `git remote set-branches` in that clone.
    expect(out).not.toContain('(missing)')
  })

  it('names the clone to fix, since the repair is local to it', () => {
    const estate = estateWithUnreadableClone()
    const { out } = run(estate, ['--check', '--repo', 'satellite'])

    expect(out).toContain(join(estate, 'satellite'))
  })

  it('fails the check rather than passing a repo it could not read', () => {
    const estate = estateWithUnreadableClone()
    const { code } = run(estate, ['--check', '--repo', 'satellite'])

    expect(code).not.toBe(0)
  })
})
