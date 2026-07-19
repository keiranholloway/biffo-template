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

  it('moves a tag when the template tree changed underneath it', () => {
    // The #294 collision: a second commit shipped the same core.version with
    // different template content. Without the move, that content is on main
    // but reachable at no version, so no instance can ever receive it.
    expect(decideTagAction({ ...state, templateTreeDiffers: true })).toBe('move')
  })

  it('refuses to move a tag that is not an ancestor of HEAD', () => {
    // Rewritten history or a hand-made tag off-branch. Force-pushing over it
    // would destroy the only record of which tree that version meant.
    expect(
      decideTagAction({ ...state, taggedCommitIsAncestorOfHead: false, templateTreeDiffers: true }),
    ).toBe('conflict')
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

  it('passes when every tag stands for its version’s template tree', () => {
    expect(auditCoreTags([fact({}), fact({ version: '0.32.5' })])).toEqual([])
  })

  it('flags the observed a2acf15/be4c573 collision as drift', () => {
    const violations = auditCoreTags([
      fact({ taggedCommit: 'a2acf15', templateTreeMatches: false }),
    ])
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
    const violations = auditCoreTags([fact({ taggedCommit: null, templateTreeMatches: false })])
    expect(violations[0]?.kind).toBe('missing')
    expect(violations[0]?.actual).toBeNull()
  })

  it('passes a tag on an earlier commit with an identical template tree', () => {
    // Correctness is about the tree, not the commit: user-owned commits between
    // the tag and the version head leave the template tree alone.
    expect(auditCoreTags([fact({ taggedCommit: 'older', templateTreeMatches: true })])).toEqual([])
  })

  it('ignores versions below the baseline', () => {
    // main carries pre-existing drift at 0.3.14 and 0.23.6 (and 0.1.0 predates
    // tagging). Those are history; the audit enforces from 0.24.0 up.
    const old = fact({ version: '0.23.6', taggedCommit: 'x', templateTreeMatches: false })
    expect(auditCoreTags([old])).toEqual([])
    expect(auditCoreTags([old], '0.1.0')).toHaveLength(1)
  })

  it('reports newest version first', () => {
    const bad = { taggedCommit: 'x', templateTreeMatches: false }
    const violations = auditCoreTags([
      fact({ version: '0.24.0', ...bad }),
      fact({ version: '0.32.4', ...bad }),
    ])
    expect(violations.map((v) => v.version)).toEqual(['0.32.4', '0.24.0'])
  })

  it('names the tag and the consequence in the failure report', () => {
    const report = formatTagViolations(
      auditCoreTags([fact({ taggedCommit: 'a2acf15', templateTreeMatches: false })]),
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
describe('sync-core-tag script', () => {
  let repo: string
  const script = join(here, '../scripts/sync-core-tag.ts')
  const tsx = join(repoRoot, 'cli/node_modules/.bin/tsx')

  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

  /** Run the script against the temp repo; never pushes (no remote, no --push). */
  const run = (): { code: number; out: string } => {
    try {
      return { code: 0, out: execFileSync(tsx, [script], { cwd: repo, encoding: 'utf8' }) }
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string }
      return { code: e.status, out: `${e.stdout}${e.stderr}` }
    }
  }

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
      'core.version': '0.32.3\n',
      'cli/x.ts': 'v3',
    })
    g('tag', '-a', 'core-v0.32.3', '-m', 'Biffo core 0.32.3')
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('creates the tag for a new version', () => {
    const sha = commit('bump', { 'core.version': '0.32.4\n', 'cli/x.ts': 'v4' })
    const { code, out } = run()
    expect(code).toBe(0)
    expect(tagged('core-v0.32.4')).toBe(sha)
    expect(out).toContain('core tag audit')
  })

  it('moves the tag when a second commit ships the same version', () => {
    // a2acf15 analogue.
    const first = commit('#291', { 'core.version': '0.32.4\n', 'cli/x.ts': 'v4-first' })
    run()
    expect(tagged('core-v0.32.4')).toBe(first)

    // be4c573 analogue: rebased, kept 0.32.4, different template content. This
    // push does not touch core.version at all — which is why the workflow can
    // no longer be path-filtered on it.
    const second = commit('#292', { 'cli/x.ts': 'v4-second' })
    const { code, out } = run()

    expect(code).toBe(0)
    expect(tagged('core-v0.32.4')).toBe(second)
    // Loud, not silent: a moving tag is surprising and must be visible in the run.
    expect(out).toContain('::warning::')
    expect(out).toContain('Moving core-v0.32.4')
    expect(out).toContain('cli/x.ts')
  })

  it('leaves the tag alone when only user-owned paths changed', () => {
    const first = commit('bump', { 'core.version': '0.32.4\n', 'cli/x.ts': 'v4' })
    run()
    commit('docs', { 'docs/ADR/0007-x.md': 'notes', 'apps/portal/page.tsx': 'x' })
    const { code, out } = run()

    expect(code).toBe(0)
    expect(tagged('core-v0.32.4')).toBe(first)
    expect(out).toContain('already stands for this template tree')
    expect(out).not.toContain('::warning::')
  })

  it('ignores a new instance migration — user-owned inside a template-owned tree', () => {
    const first = commit('bump', { 'core.version': '0.32.4\n', 'cli/x.ts': 'v4' })
    run()
    commit('migration', { 'services/api/migrations/versions/abc_add_table.py': 'revision = "abc"' })
    run()
    expect(tagged('core-v0.32.4')).toBe(first)
  })

  it('fails rather than clobbering a tag that is not an ancestor of HEAD', () => {
    commit('bump', { 'core.version': '0.32.4\n', 'cli/x.ts': 'v4' })
    g('checkout', '-q', '-b', 'sidebranch')
    commit('elsewhere', { 'cli/x.ts': 'off-branch' })
    g('tag', '-a', 'core-v0.32.4', '-m', 'off-branch')
    g('checkout', '-q', 'main')

    const { code, out } = run()
    expect(code).toBe(1)
    expect(out).toContain('::error::')
    expect(out).toContain('Refusing to move')
  })

  it('does nothing in an instance', () => {
    commit('instance', {
      'core.version': '0.32.4\n',
      'biffo.core.json': JSON.stringify({ version: '0.32.4' }),
      'cli/x.ts': 'v4',
    })
    const { code, out } = run()
    expect(code).toBe(0)
    expect(out).toContain('this is an instance')
    expect(() => tagged('core-v0.32.4')).toThrow()
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
