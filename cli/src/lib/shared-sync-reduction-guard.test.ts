import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GUARD_AUTHORITY_INVENTORY } from './guard-authority-inventory.js'

/**
 * The wiring half of #1577, and this guard's **disagreement test** in the
 * #1362 sense.
 *
 * `shared-file-reduction-guard.ts` can only refuse a deletion it is shown.
 * The thing that shows it is `stage_repo` in `scripts/shared-sync.sh`, which
 * builds a pair list from `$FILES`, `$CONDITIONAL` and `$FROM_SKELETON` and
 * hands it over before the `cp`s run. The divergent state this class is about
 * is therefore: **a write list the actor copies that the document (the pair
 * list) omits.** A fourth list added to `stage_repo`'s writes, with no
 * matching entry in the pair builder, would leave the guard reporting cleanly
 * over a file it was never given — the exact "passes because it could not
 * ask" shape the estate keeps re-finding.
 *
 * This reads the real script's source rather than running it, for the reason
 * `shared-sync-gate-invocation.test.ts` already establishes: a comment
 * asserting an invariant is not a guard on it, and executing this repo's own
 * copy of `shared-sync.sh` is forbidden outright by
 * `shared-sync-fixture-isolation.test.ts`.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SYNC = readFileSync(join(repoRoot, 'scripts/shared-sync.sh'), 'utf8')

/** Body of `stage_repo`, from its opening line to the next top-level
 * function — the only region where a write to the staged worktree belongs. */
function stageRepoBody(): string {
  const start = SYNC.indexOf('\nstage_repo() {')
  expect(start).toBeGreaterThan(-1)
  const rest = SYNC.slice(start + 1)
  const end = rest.search(/\n[a-z_]+\(\) \{/)
  return end === -1 ? rest : rest.slice(0, end)
}

const INVOCATION = 'sh scripts/biffo.sh check shared-file-reduction'

describe('shared-sync.sh runs the reduction guard before it overwrites anything', () => {
  const body = stageRepoBody()

  it('invokes the guard through the dispatcher, from stage_repo', () => {
    expect(body).toContain(INVOCATION)
  })

  /**
   * Order is the whole property. A guard that ran after the copies would be
   * comparing the canonical file with itself and would pass forever — the
   * "reports perfect health by comparing a repo to itself" defect
   * `shared-sync.sh` already documents about `.biffo-shared-version`.
   */
  it('runs BEFORE the first cp, or it compares the canonical copy with itself', () => {
    const guardAt = body.indexOf(INVOCATION)
    const firstCopyAt = body.indexOf('cp "$TEMPLATE_ROOT/')
    expect(guardAt).toBeGreaterThan(-1)
    expect(firstCopyAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(firstCopyAt)
  })

  /**
   * The disagreement construction: every list `stage_repo` WRITES from must
   * also appear in the pair list it CHECKS. Adding a fourth write list
   * without a matching pair entry is what this fails on.
   */
  it.each(['$FILES', '$CONDITIONAL', '$FROM_SKELETON'])(
    'checks the %s write list as well as copying from it',
    (list) => {
      const region = body.slice(0, body.indexOf(INVOCATION))
      expect(region).toContain(list)
    },
  )

  it('enumerates no write list the pair builder has not been taught', () => {
    // The lists `stage_repo` copies from, read off the shell variables it
    // dereferences in a write position — `for f in $X` / `[ -n "$X" ]` guards
    // around a `cp`. Kept as an explicit expectation so a NEW list shows up
    // here as a failure rather than as silence.
    const writeLists = [...body.matchAll(/\$\{?(FILES|CONDITIONAL|FROM_SKELETON)\b/g)].map(
      (m) => m[1],
    )
    expect(new Set(writeLists)).toEqual(new Set(['FILES', 'CONDITIONAL', 'FROM_SKELETON']))
  })

  /**
   * `seed` creates where absent and never touches an existing copy, so it
   * cannot delete anything and must not be checked — checking it would make
   * every repo that wrote its own CLAUDE.md identity paragraph look like a
   * reduction, which is the "permanently red in exactly the repos that did
   * the right thing" failure `diff_files` already avoids.
   */
  it('skips filesFromSkeleton seed entries, which never overwrite', () => {
    const region = body.slice(0, body.indexOf(INVOCATION))
    expect(region).toContain('= sync ] || continue')
  })

  it('writes the pair list outside the staged worktree, or it ships in the sync PR', () => {
    const region = body.slice(0, body.indexOf(INVOCATION))
    expect(region).toContain('_red_pairs=$(mktemp)')
  })

  it('aborts the stage on refusal rather than copying anyway', () => {
    expect(body).toContain('return 3')
  })
})

describe('a refusal is reported as itself, not as a staging failure', () => {
  /**
   * `stage_repo` already returns 1 for "fetch or worktree failed" and 2 for
   * "nothing to sync". Folding a refusal into 1 would print `CANNOT STAGE -
   * fetch or worktree failed` and send whoever read the table looking at git,
   * when the fix is upstream in the template.
   */
  it('phase 1 distinguishes exit 3', () => {
    expect(SYNC).toContain('[ "$stage_rc" -eq 3 ]')
    expect(SYNC).toContain('WOULD DELETE CONTENT')
  })

  it('phase 2 (--no-rehearse) distinguishes it too, or the refusal is bypassable', () => {
    const shipPhase = SYNC.slice(SYNC.indexOf('# ---- Phase 2: ship'))
    expect(shipPhase).toContain('3) printf')
  })
})

describe('the guard is counted by the estate sweeps', () => {
  it('is in the #1362 authority inventory', () => {
    const record = GUARD_AUTHORITY_INVENTORY.find((r) => r.id === 'shared-file-reduction-guard')
    expect(record).toBeDefined()
    expect(record?.path).toBe('cli/src/lib/shared-file-reduction-guard.ts')
    expect(record?.disagreementTest).toBe('cli/src/lib/shared-sync-reduction-guard.test.ts')
  })
})
