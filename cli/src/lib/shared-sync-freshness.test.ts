import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * The sending side of `shared-sync.sh` must be as distrusted as the receiving
 * side already is.
 *
 * The receiving side reads `origin/<base>` refs, never a working tree —
 * deliberately, because a stale checkout on the measuring machine once produced
 * a fake 4-variant reading of `api-client.ts`. The template side had no such
 * protection: every file distributed, and every comparison `--check` makes,
 * comes from `$TEMPLATE_ROOT`, whatever tree the caller happens to be in.
 *
 * That asymmetry bit three times in one session on 2026-08-03. The worst was a
 * sweep that shipped the PREVIOUS `.githooks/pre-push` to 14 repos while
 * deleting the script it guarded — which would have left the `[ -f … ]` branch
 * that warns and continues, silently disabling the force-push guard estate-wide.
 *
 * Every one of those produced confident, well-formed, wrong output. Being
 * behind is not an error condition in git; it has to be made into one.
 */
function templateClone(): { clone: string; estate: string } {
  const root = makeTmpDir('syncfresh')
  const origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  const estate = join(root, 'estate')
  mkdirSync(estate, { recursive: true })

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd })

  execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', origin])
  execFileSync('git', ['init', '-q', '-b', 'dev', seed])
  mkdirSync(join(seed, 'scripts'), { recursive: true })
  copyFileSync(join(repoRoot, 'scripts/shared-sync.sh'), join(seed, 'scripts/shared-sync.sh'))
  // A minimal manifest: the preflight runs before any of it is used, and a
  // fuller one would make this test about the survey instead.
  writeFileSync(
    join(seed, 'shared-files.json'),
    JSON.stringify({ appliesTo: ['biffo.sibling.json'], files: [] }, null, 2) + '\n',
  )
  git(seed, 'add', '-A')
  git(seed, 'commit', '-qm', 'seed')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-q', 'origin', 'dev')

  const clone = join(root, 'clone')
  execFileSync('git', ['clone', '-q', origin, clone])

  // Move origin ahead AFTER cloning: the clone is now genuinely behind, which
  // is the exact state a primary checkout drifts into between merges.
  writeFileSync(join(seed, 'moved-on.txt'), 'origin advanced\n')
  git(seed, 'add', '-A')
  git(seed, 'commit', '-qm', 'origin moves on')
  git(seed, 'push', '-q', 'origin', 'dev')

  return { clone, estate }
}

const run = (clone: string, estate: string) =>
  spawnSync('sh', ['scripts/shared-sync.sh', '--check', '--estate', estate], {
    cwd: clone,
    encoding: 'utf8',
  })

describe('shared-sync refuses to ship from a stale template checkout', () => {
  it('exits 2 — "cannot tell", never a pass — and names the fix', () => {
    const { clone, estate } = templateClone()
    const result = run(clone, estate)
    const output = `${result.stdout}${result.stderr}`

    // Not 0 and not 1: this is the estate's third value. A stale run previously
    // reported `1 current, 0 drifted` — a true statement about a stale question.
    expect(result.status, output).toBe(2)
    expect(output).toContain('behind origin/dev')
    expect(output).toContain('git pull --ff-only origin dev')
  })

  it('refuses uncommitted changes only on the SHIPPING path', () => {
    const { clone, estate } = templateClone()
    execFileSync('git', ['pull', '-q', '--ff-only', 'origin', 'dev'], { cwd: clone })
    // Current, but dirty in a distributed path. Shipping this would push
    // content no satellite could trace back to a commit.
    writeFileSync(join(clone, 'scripts/extra.sh'), '# not committed\n')
    execFileSync('git', ['add', '-A'], { cwd: clone })

    const ship = spawnSync('sh', ['scripts/shared-sync.sh', '--estate', estate], {
      cwd: clone,
      encoding: 'utf8',
    })
    expect(ship.status, `${ship.stdout}${ship.stderr}`).toBe(2)
    expect(`${ship.stdout}${ship.stderr}`).toContain('uncommitted changes')

    // --check writes nothing, and blocking it on a dirty tree would block the
    // one command you reach for WHILE editing shared files.
    const check = run(clone, estate)
    expect(`${check.stdout}${check.stderr}`).not.toContain('uncommitted changes')
  })

  it('does not fire when the checkout is current', () => {
    const { clone, estate } = templateClone()
    execFileSync('git', ['pull', '-q', '--ff-only', 'origin', 'dev'], { cwd: clone })

    const result = run(clone, estate)
    // It may still exit non-zero for unrelated reasons in a bare fixture, but it
    // must get PAST the preflight — the freshness message must be absent.
    expect(`${result.stdout}${result.stderr}`).not.toContain('behind origin/dev')
    expect(`${result.stdout}${result.stderr}`).not.toContain('uncommitted changes')
  })
})
