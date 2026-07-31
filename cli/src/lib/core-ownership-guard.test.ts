import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCoreManifest } from './core-manifest.js'
import {
  DIVERGENCE_FILE,
  type DivergenceEntry,
  checkCoreOwnership,
  parseConvergenceTrailer,
  parseDivergenceTrailer,
  parseNameStatus,
  readDivergenceConfig,
  resolveBranch,
} from './core-ownership-guard.js'
import { upgradeBranchName } from './core-upgrade.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const manifest = readCoreManifest(repoRoot)

const check = (input: Partial<Parameters<typeof checkCoreOwnership>[0]>) =>
  checkCoreOwnership({ changedFiles: [], manifest, isInstance: true, ...input })

describe('checkCoreOwnership — direction of the check', () => {
  /**
   * The bug the ported version of this guard would have had. The instance-side
   * original probed `existsSync('core-manifest.json')`, which is true in the
   * TEMPLATE too — so shipped upstream unchanged it would have refused every
   * commit in the repo it ships from.
   */
  it('is inert in the template, which owns these paths', () => {
    const result = check({ changedFiles: ['services/api/src/api/main.py'], isInstance: false })
    expect(result.skipped).toBe('template')
    expect(result.blocked).toEqual([])
  })

  it('blocks the same change in an instance', () => {
    const result = check({ changedFiles: ['services/api/src/api/main.py'] })
    expect(result.skipped).toBeNull()
    expect(result.blocked).toEqual(['services/api/src/api/main.py'])
  })

  it('makes the caller state which side it is on', () => {
    // No default: the polarity is inverted relative to the core.version guard,
    // so defaulting either way is a trap (see the note on the input type). This
    // is a type-level guarantee — asserted here so removing it is a visible
    // change rather than a silently-restored default.
    // @ts-expect-error -- isInstance is required
    expect(() => checkCoreOwnership({ changedFiles: [], manifest })).not.toThrow()
  })
})

describe('checkCoreOwnership — what it lets through', () => {
  it('ignores user-owned paths', () => {
    const result = check({
      changedFiles: ['infra/environments/dev/main.tf', 'db/seed.sql', 'apps/my-app/page.tsx'],
    })
    expect(result.blocked).toEqual([])
    expect(result.skipped).toBeNull()
  })

  it('resolves ownership by longest prefix, as the upgrade does', () => {
    // services/ is user-owned; services/api/ inside it is not. A guard that
    // matched on the shortest prefix would wave the real drift through.
    const result = check({
      changedFiles: ['services/billing/handler.py', 'services/api/src/api/models/base.py'],
    })
    expect(result.blocked).toEqual(['services/api/src/api/models/base.py'])
  })

  it('lets an instance add its own *.instance.yml workflow, and nothing else under .github/ (#755)', () => {
    // The carve-out: a CI lane an instance authored for something only it has
    // needs no `Core-Divergence:` trailer, because there is no template file to
    // diverge from.
    const allowed = check({
      changedFiles: ['.github/workflows/db-tests.instance.yml'],
    })
    expect(allowed.blocked).toEqual([])
    expect(allowed.skipped).toBeNull()

    // ...and the guard still hard-blocks every other path under .github/,
    // including any edit to a template-shipped workflow. A carve-out that
    // accidentally widened would be worth more than the friction it removes.
    const blocked = check({
      changedFiles: [
        '.github/workflows/ci.yml',
        '.github/workflows/deploy-app.yml',
        '.github/dependabot.yml',
        '.github/workflows/nested/db.instance.yml',
      ],
    })
    expect(blocked.blocked).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/deploy-app.yml',
      '.github/dependabot.yml',
      '.github/workflows/nested/db.instance.yml',
    ])
  })

  it('exempts a core-upgrade branch, which is when these paths are meant to move', () => {
    const result = check({
      changedFiles: ['services/api/src/api/main.py'],
      branch: upgradeBranchName('0.23.3', '0.41.18'),
    })
    expect(result.skipped).toBe('upgrade-branch')
    expect(result.blocked).toEqual([])
  })

  /**
   * The exemption is derived from `upgradeBranchName` rather than a hand-written
   * regex, so the two cannot drift. If the upgrade ever renames its branches,
   * this fails rather than silently blocking every upgrade PR in every instance.
   */
  it('recognises the branch name the upgrade actually creates', () => {
    expect(upgradeBranchName('1.0.0', '1.1.0')).toMatch(/^biffo\/core-upgrade-/)
  })

  it('does not exempt a branch that merely mentions the words', () => {
    const result = check({
      changedFiles: ['packages/ui/src/index.ts'],
      branch: 'fix/notes-about-biffo-core-upgrade',
    })
    expect(result.skipped).toBeNull()
    expect(result.blocked).toEqual(['packages/ui/src/index.ts'])
  })

  it('allows an explicit Core-Divergence trailer, and reports the reason', () => {
    const result = check({
      changedFiles: ['packages/ui/src/index.ts'],
      commitMessage: 'fix: something\n\nCore-Divergence: upstream cannot express this yet\n',
    })
    expect(result.skipped).toBe('divergence-trailer')
    expect(result.blocked).toEqual([])
    expect(result.divergenceReason).toBe('upstream cannot express this yet')
    expect(result.convergenceReason).toBeNull()
  })

  it('allows a Core-Convergence trailer, kept DISTINCT from divergence (#385)', () => {
    // Reverting a template-owned file to the template's own content is strictly
    // less divergence — the case the guard used to force a false Core-Divergence
    // trailer onto.
    const result = check({
      changedFiles: ['apps/portal/src/app/layout.tsx'],
      commitMessage:
        'chore: adopt the portal split\n\nCore-Convergence: revert layout.tsx to the template\n',
    })
    expect(result.skipped).toBe('convergence-trailer')
    expect(result.blocked).toEqual([])
    expect(result.convergenceReason).toBe('revert layout.tsx to the template')
    expect(result.divergenceReason).toBeNull()
  })

  it('records a commit as divergence, not convergence, when BOTH trailers are present', () => {
    // A commit that adds any drift must not be laundered as a convergence.
    const result = check({
      changedFiles: ['packages/ui/src/index.ts'],
      commitMessage:
        'chore: mixed\n\nCore-Divergence: instance needs X\nCore-Convergence: also reverts Y\n',
    })
    expect(result.skipped).toBe('divergence-trailer')
    expect(result.divergenceReason).toBe('instance needs X')
    expect(result.convergenceReason).toBeNull()
  })

  it('a Core-Convergence trailer does not excuse a change with no template-owned paths', () => {
    // Nothing to excuse — user-owned changes were never blocked.
    const result = check({
      changedFiles: ['db/seed.sql'],
      commitMessage: 'x\n\nCore-Convergence: n/a\n',
    })
    expect(result.skipped).toBeNull()
    expect(result.blocked).toEqual([])
  })
})

/**
 * Regression for the defect that blocked the first upgrade PR this guard ever
 * saw (biffo-platform#2). The guard was correct about *which* prefix to exempt
 * and wrong about how to find the branch in CI, which amounts to the same
 * outage: every core upgrade blocked, in every instance.
 */
describe('resolveBranch', () => {
  const upgradeBranch = upgradeBranchName('0.41.18', '0.49.1')

  it('prefers the PR source branch over a detached git HEAD', () => {
    // What actions/checkout actually leaves behind on a pull_request event.
    expect(resolveBranch({ GITHUB_HEAD_REF: upgradeBranch }, 'HEAD')).toBe(upgradeBranch)
  })

  it('exempts the upgrade PR end to end, which is the whole point', () => {
    const result = check({
      changedFiles: ['services/api/src/api/main.py', 'packages/ui/src/index.ts'],
      branch: resolveBranch({ GITHUB_HEAD_REF: upgradeBranch }, 'HEAD'),
    })
    expect(result.skipped).toBe('upgrade-branch')
    expect(result.blocked).toEqual([])
  })

  it('negative control: the same change WITHOUT the env is blocked', () => {
    // Proof the exemption above comes from resolveBranch and not from the
    // change being harmless — this is the pre-fix behaviour.
    const result = check({
      changedFiles: ['services/api/src/api/main.py', 'packages/ui/src/index.ts'],
      branch: resolveBranch({}, 'HEAD'),
    })
    expect(result.skipped).toBeNull()
    expect(result.blocked).toHaveLength(2)
  })

  it('falls back to GITHUB_REF_NAME on push events', () => {
    expect(resolveBranch({ GITHUB_REF_NAME: 'dev' }, 'HEAD')).toBe('dev')
    // HEAD_REF wins when both are set: on a pull_request, REF_NAME is the
    // merge ref (`123/merge`), not the branch.
    expect(resolveBranch({ GITHUB_HEAD_REF: 'feat/x', GITHUB_REF_NAME: '12/merge' }, 'HEAD')).toBe(
      'feat/x',
    )
  })

  it('falls back to git locally, where the branch is real', () => {
    expect(resolveBranch({}, upgradeBranch)).toBe(upgradeBranch)
  })

  it('treats an empty env var as absent rather than as a branch named ""', () => {
    expect(resolveBranch({ GITHUB_HEAD_REF: '' }, 'dev')).toBe('dev')
  })
})

describe('parseDivergenceTrailer', () => {
  it('requires the trailer on its own line, not mentioned in prose', () => {
    expect(parseDivergenceTrailer('fix: discuss Core-Divergence: later maybe')).toBeNull()
  })

  it('requires a reason', () => {
    expect(parseDivergenceTrailer('fix: x\n\nCore-Divergence:\n')).toBeNull()
    expect(parseDivergenceTrailer('fix: x\n\nCore-Divergence:   \n')).toBeNull()
  })

  it('trims surrounding whitespace from the reason', () => {
    expect(parseDivergenceTrailer('x\n\nCore-Divergence:   because   \n')).toBe('because')
  })

  it('ignores a trailer inside a comment line git will strip', () => {
    // The commit-msg hook sees the raw editor buffer, comments included. A
    // trailer in git's own help text is not the author opting out.
    expect(parseDivergenceTrailer('fix: x\n\n# Core-Divergence: example from the template\n')).toBe(
      null,
    )
  })

  it('does not confuse Core-Convergence for Core-Divergence', () => {
    expect(parseDivergenceTrailer('x\n\nCore-Convergence: reverting\n')).toBeNull()
  })
})

describe('parseConvergenceTrailer', () => {
  it('extracts the reason from a Core-Convergence trailer on its own line', () => {
    expect(parseConvergenceTrailer('chore: revert\n\nCore-Convergence: back to template\n')).toBe(
      'back to template',
    )
  })

  it('requires the trailer on its own line, not mentioned in prose', () => {
    expect(parseConvergenceTrailer('fix: discuss Core-Convergence: later maybe')).toBeNull()
  })

  it('requires a reason and trims whitespace', () => {
    expect(parseConvergenceTrailer('x\n\nCore-Convergence:\n')).toBeNull()
    expect(parseConvergenceTrailer('x\n\nCore-Convergence:   back   \n')).toBe('back')
  })

  it('ignores a trailer inside a comment line git will strip', () => {
    expect(parseConvergenceTrailer('x\n\n# Core-Convergence: example\n')).toBeNull()
  })

  it('does not confuse Core-Divergence for Core-Convergence', () => {
    expect(parseConvergenceTrailer('x\n\nCore-Divergence: needs it\n')).toBeNull()
  })
})

describe('checkCoreOwnership — warn-only prefixes', () => {
  const portal: DivergenceEntry = {
    prefix: 'apps/portal/',
    reason: 'product UI predates the boundary widening',
    upstream: 'keiranholloway/biffo-template#370',
  }

  it('warns instead of blocking for an acknowledged prefix', () => {
    const result = check({
      changedFiles: ['apps/portal/src/app/page.tsx'],
      warnOnly: [portal],
    })
    expect(result.blocked).toEqual([])
    expect(result.warned.map((w) => w.path)).toEqual(['apps/portal/src/app/page.tsx'])
    expect(result.warned[0]?.entry.upstream).toBe('keiranholloway/biffo-template#370')
  })

  it('still blocks everything outside the acknowledged prefix', () => {
    const result = check({
      changedFiles: ['apps/portal/src/app/page.tsx', 'services/api/src/api/main.py'],
      warnOnly: [portal],
    })
    expect(result.blocked).toEqual(['services/api/src/api/main.py'])
    expect(result.warned).toHaveLength(1)
  })

  it('reports the most specific matching entry', () => {
    const admin: DivergenceEntry = {
      prefix: 'apps/portal/src/app/admin/',
      reason: 'narrower, more specific reason',
      upstream: '#360',
    }
    const result = check({
      changedFiles: ['apps/portal/src/app/admin/page.tsx'],
      warnOnly: [portal, admin],
    })
    expect(result.warned[0]?.entry.upstream).toBe('#360')
  })

  /**
   * A warn-only entry excuses the block, not the drift. Surfacing the warning
   * on a trailer-allowed commit is what keeps the list from becoming a place
   * divergence goes to be forgotten.
   */
  it('still surfaces warnings when a trailer allows the rest', () => {
    const result = check({
      changedFiles: ['apps/portal/src/app/page.tsx', 'packages/ui/src/index.ts'],
      commitMessage: 'x\n\nCore-Divergence: deliberate\n',
      warnOnly: [portal],
    })
    expect(result.skipped).toBe('divergence-trailer')
    expect(result.warned).toHaveLength(1)
  })
})

describe('readDivergenceConfig', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'biffo-divergence-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('treats an absent file as no warn-only prefixes', () => {
    expect(readDivergenceConfig(dir).warnOnly).toEqual([])
  })

  it('reads entries', () => {
    writeFileSync(
      join(dir, DIVERGENCE_FILE),
      JSON.stringify({ warnOnly: [{ prefix: 'apps/portal/', reason: 'r', upstream: '#370' }] }),
    )
    expect(readDivergenceConfig(dir).warnOnly).toHaveLength(1)
  })

  /**
   * Loud, not lenient. Degrading a broken config to "no warn-only prefixes"
   * silently converts every warn into a block, so the guard starts refusing
   * commits it was configured to allow with no indication why.
   */
  it('throws on malformed JSON rather than silently dropping the list', () => {
    writeFileSync(join(dir, DIVERGENCE_FILE), '{ not json')
    expect(() => readDivergenceConfig(dir)).toThrow(/not valid JSON/)
  })

  it('requires an upstream issue on every entry', () => {
    // An entry with no issue to close it is permanent drift wearing a
    // temporary label.
    writeFileSync(
      join(dir, DIVERGENCE_FILE),
      JSON.stringify({ warnOnly: [{ prefix: 'apps/portal/', reason: 'r' }] }),
    )
    expect(() => readDivergenceConfig(dir)).toThrow(/invalid/)
  })
})

describe('the real manifest', () => {
  /**
   * Negative control. Every assertion above drives a hand-written path list; if
   * `isTemplateOwned` were wired up wrongly here the suite could still pass by
   * agreeing with itself. These drive the REAL manifest, and the guard must
   * disagree between the two sides of the boundary — a guard that classifies
   * everything the same way is not a guard.
   */
  it('separates real template-owned from real user-owned paths', () => {
    const blocked = check({
      changedFiles: [
        'services/api/src/api/main.py',
        'packages/ui/src/index.ts',
        'modules/cloud/aws/main.tf',
        '.github/workflows/ci.yml',
        'core-manifest.json',
      ],
    }).blocked
    expect(blocked).toHaveLength(5)

    const allowed = check({
      changedFiles: [
        'infra/environments/dev/main.tf',
        'services/api/migrations/versions/0009_x.py',
        'docs/ADR/0001-tenancy.md',
        'db/seed.sql',
        'biffo.core.json',
      ],
    }).blocked
    expect(allowed).toEqual([])
  })

  it('does not block the divergence config itself', () => {
    // Otherwise recording a divergence would be blocked by the guard it
    // configures — the instance could never adopt one.
    expect(check({ changedFiles: [DIVERGENCE_FILE] }).blocked).toEqual([])
  })
})

/**
 * Regression for #411. The CI diff and the staged diff used different
 * `--diff-filter`s, so a commit deleting a template-owned path passed the
 * commit-msg hook and then failed CI — the same commit, two verdicts, and the
 * failure only visible after push.
 *
 * The existing tests drive `checkCoreOwnership` with hand-built path lists, so
 * they could never see the difference between the two `git diff` invocations.
 * That is exactly why it shipped, so these test the parsing both modes now
 * share.
 */
describe('parseNameStatus', () => {
  it('reports modifications and additions as changed, not deleted', () => {
    const { changed, deleted } = parseNameStatus('M\tcli/src/index.ts\nA\tcli/src/new.ts')
    expect(changed).toEqual(['cli/src/index.ts', 'cli/src/new.ts'])
    expect(deleted).toEqual([])
  })

  it('reports a deletion as both changed and deleted', () => {
    const { changed, deleted } = parseNameStatus('D\tmodules/plugins/orchestrator/main.tf')
    expect(changed).toEqual(['modules/plugins/orchestrator/main.tf'])
    expect(deleted).toEqual(['modules/plugins/orchestrator/main.tf'])
  })

  it('classifies a rename by its destination — the path that exists afterwards', () => {
    const { changed, deleted } = parseNameStatus('R100\tcli/src/old.ts\tcli/src/new.ts')
    expect(changed).toEqual(['cli/src/new.ts'])
    expect(deleted).toEqual([])
  })

  it('ignores blank and malformed lines rather than inventing a path', () => {
    expect(parseNameStatus('\n\nM\ta.ts\n\n').changed).toEqual(['a.ts'])
    expect(parseNameStatus('garbage').changed).toEqual([])
  })

  it('a deletion-only diff is not an empty diff', () => {
    // The bug in miniature: filtered out, this looked like "nothing changed".
    const { changed } = parseNameStatus('D\tservices/api/src/api/main.py')
    expect(changed).toHaveLength(1)
  })
})

describe('deleting a template-owned file is drift (#411)', () => {
  it('blocks it, rather than treating deletion as a lesser change', () => {
    // A core upgrade will not restore a deleted template-owned file (#395), so
    // the instance loses it silently and permanently. That is worse than an
    // edit, not better.
    const result = check({ changedFiles: ['services/api/src/api/routers/orchestration.py'] })
    expect(result.blocked).toEqual(['services/api/src/api/routers/orchestration.py'])
  })

  it('still lets a recorded divergence through', () => {
    const result = check({
      changedFiles: ['modules/cloud/aws/cdn/main.tf'],
      commitMessage:
        'chore: tweak the CDN module\n\nCore-Divergence: this instance needs a bespoke CDN behaviour\n',
    })
    expect(result.skipped).toBe('divergence-trailer')
  })
})

/**
 * Structural guard for #411: the two modes must issue equivalent git diffs.
 *
 * They drifted once (`--diff-filter=ACMR` on one side only) and the behavioural
 * tests could not see it, because they drive the decision function directly and
 * never run git. A refactor that re-filters one side would restore the split
 * silently, so the invariant is asserted against the source.
 */
describe('both guard modes ask git the same question', () => {
  const runnerSource = readFileSync(
    join(__dirname, '..', 'scripts', 'check-core-ownership.ts'),
    'utf8',
  )

  it('uses --name-status on both sides and filters neither', () => {
    const diffs = runnerSource.match(/'diff',[^)]*/g) ?? []
    expect(diffs.length).toBe(2)
    for (const call of diffs) {
      expect(call).toContain("'--name-status'")
      expect(call).not.toContain('--diff-filter')
    }
  })

  it('negative control: the assertion sees a filter when one is present', () => {
    const withFilter =
      "await execa('git', ['diff', '--cached', '--name-status', '--diff-filter=ACMR'])"
    expect((withFilter.match(/'diff',[^)]*/g) ?? [])[0]).toContain('--diff-filter')
  })
})
