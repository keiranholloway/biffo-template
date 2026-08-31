import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreManifest } from './core-manifest.js'
import { type MergeFileFn, planCoreUpgrade } from './core-upgrade.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * #1823: `pathHasDivergenceTrailerInHistory`'s shallow-clone handling (the
 * #1812 fix, `core-upgrade.ts`) correctly stops a `--depth 1` clone from
 * reading EVERY path as declared. Its own docstring says plainly that this
 * turns the trailer route into a permanent no-op under `--depth 1`, because
 * `git log --follow` has no local parent to diff the lone grafted boundary
 * commit against — a deeper or full clone is needed to recover the real
 * behaviour.
 *
 * `orphan-ratchet-report.yml` is the ONE caller that runs this function
 * against real, unmodified estate data on a schedule (`ci.yml`'s self-check
 * is mathematically forced to find zero, per `check-orphan-ratchet.ts`'s own
 * doc comment) — and it cloned every instance with exactly `--depth 1`, which
 * made the trailer route permanently unable to recognise ANY genuinely
 * declared divergence there, no matter how correctly scoped, turning a real,
 * historical `Core-Divergence:` trailer into a growing, un-clearable orphan
 * report forever.
 *
 * This test does not hardcode an expected clone command. It reads the REAL
 * `orphan-ratchet-report.yml` clone line and reproduces exactly the depth it
 * configures, against a synthetic repo shaped like the real
 * `biffo-platform`/`rls-tests.yml` case: a genuine, correctly-scoped,
 * single-file `Core-Divergence:` trailer declared several commits back, with
 * ordinary unrelated commits landing afterwards (so a `--depth 1` clone's
 * grafted boundary is one of the LATER commits, not the trailer commit
 * itself — the realistic shape of a live, ongoing instance, not a
 * freshly-committed fixture). It fails against the pre-#1823 workflow
 * (`--depth 1`) and passes once the workflow clones enough history for the
 * trailer to be found.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKFLOW_PATH = join(repoRoot, '.github/workflows/orphan-ratchet-report.yml')

/**
 * Extracts the `--depth <N>` argument (if any) from the real workflow's
 * `gh repo clone` invocation. Returns `null` for a full (unbounded) clone.
 * Throws if the clone line's shape has changed enough that this can no
 * longer be found — a silent `null` here would make this test validate
 * nothing.
 */
function parseConfiguredCloneDepth(): number | null {
  const yaml = readFileSync(WORKFLOW_PATH, 'utf8')
  const m = /gh repo clone "\$slug" "\$ESTATE\/\$name" -- --quiet(?:\s+--depth\s+(\d+))?/.exec(yaml)
  expect(
    m,
    'orphan-ratchet-report.yml still clones each instance via `gh repo clone "$slug" "$ESTATE/$name" -- --quiet[...]`',
  ).not.toBeNull()
  return m?.[1] !== undefined ? Number(m[1]) : null
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function initRepo(repo: string): void {
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
}

function w(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

/** Written via `-F <file>`, same reason as the sibling trailer test file: a
 * commit message is shell input and must never go through `-m`. */
function commit(repo: string, message: string): void {
  const msgFile = join(repo, '.git', 'COMMIT_MSG_FIXTURE')
  writeFileSync(msgFile, message)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-F', msgFile])
}

const neverMerges: MergeFileFn = async () => {
  throw new Error('classify() reached the merge step for a path with no base and no theirs')
}

describe('orphan-ratchet-report.yml clones with enough history for the trailer route to mean anything (#1823)', () => {
  let base: string
  let ours: string
  let theirs: string

  beforeEach(() => {
    base = makeTmpDir('base')
    ours = makeTmpDir('ours')
    theirs = makeTmpDir('theirs')
  })
  afterEach(() => {
    for (const d of [base, ours, theirs]) rmSync(d, { recursive: true, force: true })
  })

  const DIVERGED = '.github/workflows/rls-tests.yml'
  const manifest: CoreManifest = {
    version: 1,
    templateOwned: [DIVERGED],
    userOwned: [],
  }

  it(
    'a genuinely, correctly-scoped Core-Divergence trailer declared several commits back is ' +
      'still recognised when cloned exactly the way orphan-ratchet-report.yml clones a real instance',
    async () => {
      // The real biffo-platform shape: rls-tests.yml is declared divergent
      // once, then ordinary, unrelated instance work continues landing on
      // top of it for a long time afterwards.
      initRepo(ours)
      w(ours, DIVERGED, 'name: RLS Tests\n')
      commit(
        ours,
        'infra(ci): add the real-Postgres RLS lane\n\n' +
          'Core-Divergence: template gate matches this exact path and name (#1602)\n',
      )
      for (let i = 0; i < 5; i += 1) {
        w(ours, `notes/entry-${i}.md`, `unrelated change ${i}\n`)
        commit(ours, `chore: unrelated instance work ${i}, no trailer here\n`)
      }

      const depth = parseConfiguredCloneDepth()
      const cloneArgs = [
        'clone',
        '--quiet',
        // `file://` forces the transport ("smart") path rather than git's
        // local-clone hardlink optimisation, which silently IGNORES --depth
        // altogether (with only a warning) and would produce a full clone —
        // the opposite of what this test needs to reproduce when the
        // workflow is (mis)configured with a depth limit.
        ...(depth !== null ? ['--depth', String(depth)] : []),
        `file://${ours}`,
        '.',
      ]
      const clone = makeTmpDir('orphan-ratchet-clone')
      git(clone, cloneArgs)
      if (depth !== null) {
        expect(git(clone, ['rev-parse', '--is-shallow-repository']).trim()).toBe('true')
      }

      const plan = await planCoreUpgrade({
        baseDir: base,
        oursDir: clone,
        theirsDir: theirs,
        manifest,
        mergeFile: neverMerges,
      })

      // This is the line that fails against the pre-#1823 workflow
      // (`--depth 1`): the trailer commit is 5 commits behind the shallow
      // boundary, so `git log --follow` cannot see it at all, and
      // rls-tests.yml is reported as an orphan despite genuinely, correctly
      // carrying a `Core-Divergence:` trailer — a real, permanent false
      // failure in the one production caller that runs against real,
      // unmodified estate data, not a fixture.
      const entry = plan.entries.find((e) => e.path === DIVERGED)
      expect(
        entry?.orphaned,
        'orphan-ratchet-report.yml must clone enough history for a genuinely-declared ' +
          'divergence several commits back to still be recognised — see #1823',
      ).not.toBe(true)
      expect(plan.orphaned.map((e) => e.path)).not.toContain(DIVERGED)
    },
  )
})
