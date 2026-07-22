import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreManifest } from './core-manifest.js'
import {
  AUDIT_BASELINE_VERSION,
  auditCoreTags,
  coreVersionTag,
  decideTagAction,
  formatTagViolations,
  templateOwnedPathspecs,
  type CoreTagFact,
} from './core-tags.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')

const manifest: CoreManifest = {
  version: 1,
  templateOwned: ['cli/', 'services/api/', '.github/', 'core-manifest.json'],
  userOwned: ['services/', 'services/api/migrations/versions/', 'docs/ADR/', 'apps/'],
}

describe('templateOwnedPathspecs', () => {
  it('includes every template-owned path', () => {
    const specs = templateOwnedPathspecs(manifest)
    for (const p of manifest.templateOwned) expect(specs).toContain(p)
  })

  it('excludes user-owned paths nested inside a template-owned one', () => {
    // Longest-prefix-wins ownership: migrations/versions/ is user-owned even
    // though services/api/ is template-owned, so a new instance migration must
    // not read as a template change.
    expect(templateOwnedPathspecs(manifest)).toContain(
      ':(exclude)services/api/migrations/versions/',
    )
  })

  it('does not bother excluding top-level user-owned paths', () => {
    // They were never included, so an exclude would be noise.
    const specs = templateOwnedPathspecs(manifest)
    expect(specs).not.toContain(':(exclude)apps/')
    expect(specs).not.toContain(':(exclude)docs/ADR/')
  })

  it('matches the real manifest — the exclusion carve-out is not hypothetical', () => {
    const real = JSON.parse(
      readFileSync(join(repoRoot, 'core-manifest.json'), 'utf8'),
    ) as CoreManifest
    expect(templateOwnedPathspecs(real)).toContain(':(exclude)services/api/migrations/versions/')
  })
})

describe('decideTagAction', () => {
  const state = {
    tagExists: true,
    taggedCommitIsAncestorOfHead: true,
    templateTreeDiffers: false,
  }

  it('creates a tag that does not exist yet', () => {
    expect(decideTagAction({ ...state, tagExists: false })).toBe('create')
  })

  it('keeps a tag whose template tree is unchanged', () => {
    // The common case: user-owned commits (docs, apps/, infra/) land on main
    // while the version sits still. The tag must not chase them.
    expect(decideTagAction(state)).toBe('keep')
  })

  it('refuses when the template tree changed underneath the tag', () => {
    // The #294 collision. #294 moved the tag forward here; #342 is why that is
    // now a refusal — the tag is a published release and npm cannot follow it.
    expect(decideTagAction({ ...state, templateTreeDiffers: true })).toBe('drifted')
  })

  it('refuses to move a tag that is not an ancestor of HEAD', () => {
    // Rewritten history or a hand-made tag off-branch. Force-pushing over it
    // would destroy the only record of which tree that version meant.
    expect(
      decideTagAction({ ...state, taggedCommitIsAncestorOfHead: false, templateTreeDiffers: true }),
    ).toBe('conflict')
  })

  it('never moves an existing tag, for any input', () => {
    // The load-bearing assertion, stated over the whole input space rather than
    // case by case: a `core-v*` tag that exists has been pushed and dispatched
    // to publish-cli.yml, so it names a released npm version. Repointing it
    // cannot repoint the artifact — it only makes the two disagree (#342).
    // Anything that reintroduces a move must fail here, not just in the case
    // whoever added it happened to think of.
    for (const taggedCommitIsAncestorOfHead of [true, false]) {
      for (const templateTreeDiffers of [true, false]) {
        const action = decideTagAction({
          tagExists: true,
          taggedCommitIsAncestorOfHead,
          templateTreeDiffers,
        })
        expect(['keep', 'drifted', 'conflict']).toContain(action)
      }
    }
  })
})

describe('auditCoreTags', () => {
  const fact = (over: Partial<CoreTagFact>): CoreTagFact => ({
    version: '0.32.4',
    headOfVersion: 'be4c573',
    taggedCommit: 'be4c573',
    templateTreeMatches: true,
    ...over,
  })

  /**
   * These fixtures describe the real 0.32.4 collision, so they must be audited
   * against a baseline below it — not against the production constant, which
   * moves whenever a version has to be written off (it has since passed 0.58).
   * A test of the audit's LOGIC should not change its verdict because the
   * repo's history did.
   */
  const BASELINE = '0.24.0'

  it('passes when every tag stands for its version’s template tree', () => {
    expect(auditCoreTags([fact({}), fact({ version: '0.32.5' })], BASELINE)).toEqual([])
  })

  it('flags the observed a2acf15/be4c573 collision as drift', () => {
    const violations = auditCoreTags(
      [fact({ taggedCommit: 'a2acf15', templateTreeMatches: false })],
      BASELINE,
    )
    expect(violations).toEqual([
      {
        version: '0.32.4',
        tag: 'core-v0.32.4',
        kind: 'drifted',
        expected: 'be4c573',
        actual: 'a2acf15',
      },
    ])
  })

  it('flags a version with no tag at all as missing', () => {
    const violations = auditCoreTags(
      [fact({ taggedCommit: null, templateTreeMatches: false })],
      BASELINE,
    )
    expect(violations[0]?.kind).toBe('missing')
    expect(violations[0]?.actual).toBeNull()
  })

  it('passes a tag on an earlier commit with an identical template tree', () => {
    // Correctness is about the tree, not the commit: user-owned commits between
    // the tag and the version head leave the template tree alone.
    expect(
      auditCoreTags([fact({ taggedCommit: 'older', templateTreeMatches: true })], BASELINE),
    ).toEqual([])
  })

  it('ignores versions below the baseline', () => {
    // main carries pre-existing drift at 0.3.14 and 0.23.6 (and 0.1.0 predates
    // tagging). Those are history; the audit enforces from 0.24.0 up.
    const old = fact({ version: '0.23.6', taggedCommit: 'x', templateTreeMatches: false })
    expect(auditCoreTags([old], BASELINE)).toEqual([])
    expect(auditCoreTags([old], '0.1.0')).toHaveLength(1)
  })

  it('reports newest version first', () => {
    const bad = { taggedCommit: 'x', templateTreeMatches: false }
    const violations = auditCoreTags(
      [fact({ version: '0.24.0', ...bad }), fact({ version: '0.32.4', ...bad })],
      BASELINE,
    )
    expect(violations.map((v) => v.version)).toEqual(['0.32.4', '0.24.0'])
  })

  it('names the tag and the consequence in the failure report', () => {
    const report = formatTagViolations(
      auditCoreTags([fact({ taggedCommit: 'a2acf15', templateTreeMatches: false })], BASELINE),
    )
    expect(report).toContain('core-v0.32.4')
    expect(report).toContain('ADR-0006')
  })

  it('has a baseline that is a real semver', () => {
    expect(AUDIT_BASELINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('coreVersionTag', () => {
  it('prefixes the version', () => {
    expect(coreVersionTag('0.32.4')).toBe('core-v0.32.4')
  })
})

/**
 * End-to-end over a real git repo, replaying the #294 collision: two commits
 * carrying core.version 0.32.4 with different template-owned content.
 */
/**
 * Fixture versions sit above AUDIT_BASELINE_VERSION on purpose. This block runs
 * the real script, which audits from the production baseline — and that baseline
 * moves whenever a version has to be written off (0.58.0 was, see core-tags.ts).
 * Numbering these below it would silently stop the audit assertions testing
 * anything. The 0.32.4 incident they model is still named in the comments and
 * still exercised by the unit tests above, which pin their own baseline.
 */
describe('sync-core-tag script', () => {
  let repo: string
  const script = join(here, '../scripts/sync-core-tag.ts')
  const tsx = join(repoRoot, 'cli/node_modules/.bin/tsx')

  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

  /** Run the script against the temp repo. Without args it never pushes (no --push). */
  const run = (...args: string[]): { code: number; out: string } => {
    try {
      return { code: 0, out: execFileSync(tsx, [script, ...args], { cwd: repo, encoding: 'utf8' }) }
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string }
      return { code: e.status, out: `${e.stdout}${e.stderr}` }
    }
  }

  /** The real CI invocation, against a throwaway bare remote. */
  const runPush = () => run('--push')

  const commit = (message: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true })
      writeFileSync(join(repo, path), content)
    }
    g('add', '-A')
    g('commit', '-qm', message)
    return g('rev-parse', 'HEAD').trim()
  }

  const tagged = (tag: string) => g('rev-list', '-n', '1', tag).trim()

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'biffo-core-tag-'))
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 'test@example.com')
    g('config', 'user.name', 'Test')
    commit('base', {
      'core-manifest.json': JSON.stringify(manifest),
      'core.version': '0.59.3\n',
      'cli/x.ts': 'v3',
    })
    g('tag', '-a', 'core-v0.59.3', '-m', 'Biffo core 0.59.3')
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('creates the tag for a new version', () => {
    const sha = commit('bump', { 'core.version': '0.59.4\n', 'cli/x.ts': 'v4' })
    const { code, out } = run()
    expect(code).toBe(0)
    expect(tagged('core-v0.59.4')).toBe(sha)
    expect(out).toContain('core tag audit')
  })

  // Multi-run: each `run()` spawns tsx over a real git repo, so these need more
  // than vitest's 5s default. They passed locally at ~1-4s and timed out in CI.
  it('refuses, loudly, when a second commit ships the same version', () => {
    // a2acf15 analogue.
    const first = commit('#291', { 'core.version': '0.59.4\n', 'cli/x.ts': 'v4-first' })
    run()
    expect(tagged('core-v0.59.4')).toBe(first)

    // be4c573 analogue: rebased, kept 0.59.4, different template content. This
    // push does not touch core.version at all — which is why the workflow can
    // no longer be path-filtered on it.
    commit('#292', { 'cli/x.ts': 'v4-second' })
    const { code, out } = run()

    expect(code).toBe(1)
    // The tag is a released version: core-tag.yml pushed it and dispatched
    // publish-cli.yml against it, so npm holds 0.59.4 built from `first`.
    // Moving the tag cannot move the package, so it stays where it is (#342).
    expect(tagged('core-v0.59.4')).toBe(first)
    expect(out).toContain('::error::')
    expect(out).toContain('Refusing to move core-v0.59.4')
    // Names the remedy, not just the problem.
    expect(out).toContain('core.version')
    // And the evidence: which template-owned paths actually diverged.
    expect(out).toContain('cli/x.ts')
  }, 30_000)

  // Multi-run: each `run()` spawns tsx over a real git repo, so these need more
  // than vitest's 5s default. They passed locally at ~1-4s and timed out in CI.
  it('does not push a tag it refused to move', () => {
    // Refusing in the log while still writing the ref would be the worst of
    // both — so assert on the ref, with a real remote to push to.
    const remote = mkdtempSync(join(tmpdir(), 'biffo-core-tag-remote-'))
    execFileSync('git', ['init', '-q', '--bare', remote])
    g('remote', 'add', 'origin', remote)

    const first = commit('#291', { 'core.version': '0.59.4\n', 'cli/x.ts': 'v4-first' })
    g('push', '-q', 'origin', 'main')
    runPush()
    expect(tagged('core-v0.59.4')).toBe(first)

    commit('#292', { 'cli/x.ts': 'v4-second' })
    expect(runPush().code).toBe(1)

    const remoteTag = execFileSync('git', ['-C', remote, 'rev-list', '-n', '1', 'core-v0.59.4'], {
      encoding: 'utf8',
    }).trim()
    expect(remoteTag).toBe(first)
    rmSync(remote, { recursive: true, force: true })
  }, 30_000)

  // Multi-run: each `run()` spawns tsx over a real git repo, so these need more
  // than vitest's 5s default. They passed locally at ~1-4s and timed out in CI.
  it('stays red on the next push while the drift is unresolved', () => {
    // Refusal is not a one-shot complaint. Until core.version moves, every push
    // to main fails — the audit re-derives the same fact independently, so
    // there is no state in which main is green and the tag is a lie.
    commit('#291', { 'core.version': '0.59.4\n', 'cli/x.ts': 'v4-first' })
    run()
    commit('#292', { 'cli/x.ts': 'v4-second' })
    expect(run().code).toBe(1)

    commit('unrelated docs', { 'docs/ADR/0008-x.md': 'notes' })
    expect(run().code).toBe(1)
  }, 30_000)

  // Multi-run: each `run()` spawns tsx over a real git repo, so these need more
  // than vitest's 5s default. They passed locally at ~1-4s and timed out in CI.
  it('releases the drifted tree on a bump, but stays red until the old version is settled', () => {
    // The consequence the error message has to be honest about, pinned so it
    // cannot be softened by accident.
    //
    // Bumping does what it promises — the drifted tree gets a version, a tag
    // and a release of its own — but it does not make main green, because the
    // tree at 0.59.4 on main still is not the tree core-v0.59.4 names. The
    // audit re-derives that independently of the tagging phase, so there is no
    // state in which main is green while a released tag is a lie.
    const first = commit('#291', { 'core.version': '0.59.4\n', 'cli/x.ts': 'v4-first' })
    run()
    const drifted = commit('#292', { 'cli/x.ts': 'v4-second' })
    expect(run().code).toBe(1)

    const bumped = commit('bump', { 'core.version': '0.59.5\n' })
    const afterBump = run()
    expect(tagged('core-v0.59.5')).toBe(bumped)
    expect(afterBump.code).toBe(1)
    expect(afterBump.out).toContain('core-v0.59.4')
    // 0.59.4's tag never moved: it still stands for whatever npm published.
    expect(tagged('core-v0.59.4')).toBe(first)

    // Settling it is a deliberate human act, and the escape hatch the message
    // prescribes has to actually work. Here: the operator decides 0.59.4 means
    // the later tree and repoints the tag by hand, knowing what npm holds.
    g('tag', '-f', '-a', 'core-v0.59.4', '-m', 'settled by hand', drifted)
    expect(run().code).toBe(0)
  }, 30_000)

  it('leaves the tag alone when only user-owned paths changed', () => {
    const first = commit('bump', { 'core.version': '0.59.4\n', 'cli/x.ts': 'v4' })
    run()
    commit('docs', { 'docs/ADR/0007-x.md': 'notes', 'apps/portal/page.tsx': 'x' })
    const { code, out } = run()

    expect(code).toBe(0)
    expect(tagged('core-v0.59.4')).toBe(first)
    expect(out).toContain('already stands for this template tree')
    expect(out).not.toContain('::warning::')
  })

  it('ignores a new instance migration — user-owned inside a template-owned tree', () => {
    const first = commit('bump', { 'core.version': '0.59.4\n', 'cli/x.ts': 'v4' })
    run()
    commit('migration', { 'services/api/migrations/versions/abc_add_table.py': 'revision = "abc"' })
    run()
    expect(tagged('core-v0.59.4')).toBe(first)
  })

  it('fails rather than clobbering a tag that is not an ancestor of HEAD', () => {
    commit('bump', { 'core.version': '0.59.4\n', 'cli/x.ts': 'v4' })
    g('checkout', '-q', '-b', 'sidebranch')
    commit('elsewhere', { 'cli/x.ts': 'off-branch' })
    g('tag', '-a', 'core-v0.59.4', '-m', 'off-branch')
    g('checkout', '-q', 'main')

    const { code, out } = run()
    expect(code).toBe(1)
    expect(out).toContain('::error::')
    expect(out).toContain('Refusing to move')
  })

  it('does nothing in an instance', () => {
    commit('instance', {
      'core.version': '0.59.4\n',
      'biffo.core.json': JSON.stringify({ version: '0.59.4' }),
      'cli/x.ts': 'v4',
    })
    const { code, out } = run()
    expect(code).toBe(0)
    expect(out).toContain('this is an instance')
    expect(() => tagged('core-v0.59.4')).toThrow()
  })
})

/**
 * Drift guard on the workflow that runs the above. The two properties below are
 * exactly what let #294 through, so they are asserted rather than trusted.
 */
describe('Core Version Tag workflow', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/core-tag.yml'), 'utf8')
  const trigger = workflow.split('permissions:')[0] ?? ''

  it('is not path-filtered — the collision push does not touch core.version', () => {
    expect(trigger).not.toMatch(/^\s*paths:/m)
  })

  it('still runs on pushes to main and on manual dispatch', () => {
    expect(trigger).toContain('branches: [main]')
    expect(trigger).toContain('workflow_dispatch:')
  })

  it('keeps the instance skip (#199) so an instance tags nothing', () => {
    expect(workflow).toContain('biffo.core.json')
    expect(workflow).toContain('is_template=false')
  })

  it('runs the tag sync with --push', () => {
    expect(workflow).toContain('sync:core-tag -- --push')
  })

  it('can write tags and serialises concurrent pushes', () => {
    expect(workflow).toContain('contents: write')
    expect(workflow).toContain('cancel-in-progress: false')
  })
})
