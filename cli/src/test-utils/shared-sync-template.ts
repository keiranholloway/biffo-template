import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Fixture **template checkouts** for the tests that drive
 * `scripts/shared-sync.sh`.
 *
 * ## Why a test must never run the script out of this repo's own checkout
 *
 * `shared-sync.sh` sets `TEMPLATE_ROOT` from `dirname $0/..`, so invoking
 * `<repo>/scripts/shared-sync.sh` makes **the tree the test is running in** the
 * template under test. Since #1234 that tree is also the subject of a
 * preflight: on branch `dev`, a checkout behind `origin/dev` exits 2 before
 * anything else runs.
 *
 * The result (#1252) was three tests that passed or failed on how recently the
 * developer had run `git pull`, with no code difference either side — the
 * staleness message short-circuited the code path each of them was exercising,
 * so they asserted against the preflight instead of their own subject. It reads
 * as a red `dev`, and it is invisible in CI forever, because CI checks out a
 * detached merge ref where the preflight does not apply.
 *
 * The irony is the point: the guard exists because being behind produces a
 * confident wrong ANSWER rather than an error, and it made three tests
 * staleness-sensitive in exactly that way.
 *
 * ## What these helpers give instead
 *
 * A template the test **owns**: a real git repo, on `dev`, current relative to
 * **its own** bare origin. The preflight still runs — it is not bypassed, and
 * there is deliberately no env var to bypass it with, because an escape hatch
 * on a fail-closed guard is reachable in real use by anyone the guard is
 * inconvenient for. It simply has a defined answer that the test controls.
 *
 * That answer is the fixture's own git state, not this machine's, which is the
 * whole point: the same test now gives the same result on a checkout that was
 * pulled a second ago and one four commits behind.
 *
 * `shared-sync-fixture-isolation.test.ts` is what keeps this durable: it fails
 * any `shared-sync-*.test.ts` that executes a script path derived from this
 * repository's own location.
 */

/** Committer identity, so the fixture does not depend on a configured user. */
const GIT_ID = [
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'user.name=Fixture',
  '-c',
  'commit.gpgsign=false',
]

const here = dirname(fileURLToPath(import.meta.url))

/** This repo's real `scripts/shared-sync.sh` — the file under test. Copied into
 * a fixture template, never executed where it sits. */
export const realSharedSync = join(here, '..', '..', '..', 'scripts', 'shared-sync.sh')

function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-C', dir, ...GIT_ID, ...args], { stdio: 'pipe' })
}

/**
 * Give a fixture template repo an origin it is **current** with, so
 * `shared-sync.sh`'s staleness preflight resolves on the fixture's terms
 * rather than by accident.
 *
 * Without it the fixture is on `dev` with no reachable `origin/dev`, and it
 * passes the preflight only because of how that case is currently handled —
 * a property of the guard rather than a decision of the test's. Two fixture
 * templates were in exactly that position (#1252). Anchoring costs one bare
 * repo and one push, and makes the fixture's staleness something it states.
 *
 * The bare origin is created as a sibling of `dir`. Two of the fixtures put
 * their template INSIDE the estate directory on purpose (that is what makes
 * shared-sync's "do not target yourself" exclusion load-bearing rather than
 * incidental), and a bare repo there is skipped by the estate walk's
 * `[ -e "$d/.git" ]` test, so it cannot be mistaken for a satellite.
 *
 * @param dir    a git repo on `dev` with at least one commit
 * @param origin where to put the bare origin; defaults to `<dir>-origin.git`
 * @returns the origin path
 */
export function anchorToOrigin(dir: string, origin = `${dir}-origin.git`): string {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', origin], { stdio: 'pipe' })
  git(dir, 'remote', 'add', 'origin', origin)
  git(dir, 'push', '-q', '-u', 'origin', 'dev')
  return origin
}

export interface TemplateCheckoutOptions {
  /** Overrides merged over the default manifest. */
  manifest?: Record<string, unknown>
  /** Extra files to write, as `relative path -> contents`. */
  files?: Record<string, string>
}

/**
 * A minimal but complete template checkout carrying the real
 * `scripts/shared-sync.sh`.
 *
 * Minimal on purpose: a copy of this repo's actual manifest would make every
 * test that uses it depend on what the shared set happens to contain today.
 * The default names one shared file, `scripts/verify.sh`, which is enough for a
 * satellite to be seen as drifted and therefore to be staged.
 *
 * @param root parent directory (from `makeTmpDir`)
 * @returns the template checkout directory
 */
export function makeTemplateCheckout(root: string, opts: TemplateCheckoutOptions = {}): string {
  const dir = join(root, 'template')
  mkdirSync(join(dir, 'scripts'), { recursive: true })

  copyFileSync(realSharedSync, join(dir, 'scripts', 'shared-sync.sh'))
  chmodSync(join(dir, 'scripts', 'shared-sync.sh'), 0o755)

  // The gate a satellite runs during rehearsal, and the coverage reader
  // `rehearse_repo` runs from $TEMPLATE_ROOT. Both are stubs: what they report
  // is another test's subject, and a real one would drag this fixture's
  // outcome back onto this repo's contents.
  for (const name of ['verify.sh', 'gate-coverage.sh']) {
    writeFileSync(join(dir, 'scripts', name), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, 'scripts', name), 0o755)
  }

  writeFileSync(
    join(dir, 'shared-files.json'),
    `${JSON.stringify(
      {
        version: 1,
        files: ['scripts/verify.sh'],
        appliesTo: ['biffo.sibling.json', 'biffo.plugin.json'],
        ...opts.manifest,
      },
      null,
      2,
    )}\n`,
  )

  for (const [rel, contents] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), contents)
  }

  execFileSync('git', ['init', '-q', '-b', 'dev', dir], { stdio: 'pipe' })
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'chore: fixture template')
  anchorToOrigin(dir)

  return dir
}

/** The script to execute for a fixture template built by
 * `makeTemplateCheckout`. */
export function sharedSyncIn(templateDir: string): string {
  return join(templateDir, 'scripts', 'shared-sync.sh')
}
