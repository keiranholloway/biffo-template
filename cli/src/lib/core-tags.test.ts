import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreManifest } from './core-manifest.js'
import { coreVersionTag, releasePathspecs, templateOwnedPathspecs } from './core-tags.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')

const manifest: CoreManifest = {
  version: 1,
  templateOwned: ['cli/', 'services/api/', '.github/', 'core-manifest.json'],
  userOwned: ['services/', 'services/api/migrations/versions/', 'docs/ADR/', 'apps/'],
  released: [],
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

describe('releasePathspecs', () => {
  // `tools/` is in neither list, so it can only appear via `released`.
  const withReleased = { ...manifest, released: ['tools/'] }

  it('adds released-but-not-distributed paths to the distributed set', () => {
    expect(releasePathspecs(withReleased)).toContain('tools/')
    expect(templateOwnedPathspecs(withReleased)).not.toContain('tools/')
  })

  it('keeps the nested user-owned exclusion', () => {
    expect(releasePathspecs(withReleased)).toContain(':(exclude)services/api/migrations/versions/')
  })

  it('is the distributed set when nothing is released separately', () => {
    expect(releasePathspecs(manifest)).toEqual(templateOwnedPathspecs(manifest))
  })

  it('matches the real manifest — cli/ releases without distributing', () => {
    const real = JSON.parse(
      readFileSync(join(repoRoot, 'core-manifest.json'), 'utf8'),
    ) as CoreManifest
    expect(releasePathspecs(real)).toContain('cli/')
    expect(templateOwnedPathspecs(real)).not.toContain('cli/')
  })
})

describe('coreVersionTag', () => {
  it('prefixes the version', () => {
    expect(coreVersionTag('0.32.4')).toBe('core-v0.32.4')
  })
})

/**
 * End-to-end over a real git repo: the release job exactly as CI runs it.
 *
 * The version is derived, not read (#423), so the scenarios that used to
 * dominate this file — a tag whose template tree drifted underneath it, two
 * commits shipping one version, the historical audit that caught both — model
 * states the script can no longer reach. What replaces them is the property
 * that makes them unreachable, asserted directly: **every release is strictly
 * newer than every tag that exists**, whatever the repo is handed.
 */
describe('sync-core-tag script', () => {
  let repo: string
  let remote: string
  const script = join(here, '../scripts/sync-core-tag.ts')
  const tsx = join(repoRoot, 'cli/node_modules/.bin/tsx')

  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

  /** Run the script against the temp repo. Without args it never pushes. */
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
  const tags = () =>
    g('tag', '--list', 'core-v*')
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
      .sort()

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'biffo-core-tag-'))
    remote = mkdtempSync(join(tmpdir(), 'biffo-core-tag-remote-'))
    execFileSync('git', ['init', '-q', '--bare', remote])
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 'test@example.com')
    g('config', 'user.name', 'Test')
    g('remote', 'add', 'origin', remote)
    commit('base', {
      'core-manifest.json': JSON.stringify(manifest),
      'cli/x.ts': 'v3',
    })
    g('tag', '-a', 'core-v0.59.3', '-m', 'Biffo core 0.59.3')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('releases a patch for a fix', () => {
    const sha = commit('fix(cli): correct the thing', { 'cli/x.ts': 'v4' })
    const { code, out } = runPush()
    expect(code).toBe(0)
    expect(out).toContain('core-v0.59.4')
    expect(tagged('core-v0.59.4')).toBe(sha)
  })

  it('releases a minor for a feature', () => {
    const sha = commit('feat(api): add the thing', { 'cli/x.ts': 'v4' })
    expect(runPush().code).toBe(0)
    expect(tagged('core-v0.60.0')).toBe(sha)
  })

  // Without --push it reports and changes nothing — not even a local tag. The
  // old script tagged first and decided whether to push afterwards, so a dry
  // run left a tag behind that the next real run then treated as released.
  it('creates no tag at all without --push', () => {
    commit('fix(cli): correct the thing', { 'cli/x.ts': 'v4' })
    const { code, out } = run()
    expect(code).toBe(0)
    expect(out).toContain('would create core-v0.59.4')
    expect(out).toContain('0.59.3 → 0.59.4')
    expect(tags()).toEqual(['core-v0.59.3'])
  })

  it('pushes the tag it created', () => {
    const sha = commit('fix(cli): correct the thing', { 'cli/x.ts': 'v4' })
    const { code, out } = runPush()
    expect(code).toBe(0)
    expect(out).toContain('Created and pushed core-v0.59.4')
    expect(
      execFileSync('git', ['-C', remote, 'rev-list', '-n', '1', 'core-v0.59.4'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe(sha)
  })

  /**
   * The #342 property, now structural rather than policed. Reissuing 0.59.4
   * would contradict an immutable npm artifact; here the second release cannot
   * even be *named* 0.59.4, because derivation starts from the highest tag —
   * which by then is 0.59.4 itself.
   */
  it('never reissues a version, because it derives from the highest tag', () => {
    const first = commit('fix(cli): one', { 'cli/x.ts': 'v4' })
    runPush()
    const second = commit('fix(cli): two', { 'cli/x.ts': 'v5' })
    runPush()

    expect(tagged('core-v0.59.4')).toBe(first)
    expect(tagged('core-v0.59.5')).toBe(second)
    expect(tags()).toEqual(['core-v0.59.3', 'core-v0.59.4', 'core-v0.59.5'])
  })

  it('derives from the highest tag, not the most recently created one', () => {
    // A hotfix tag created after a higher one. Ordering by creation date would
    // resolve 0.59.9 as the base and mint 0.59.10 — behind the live 0.60.0.
    commit('feat(cli): big', { 'cli/x.ts': 'v-big' })
    runPush() // 0.60.0
    g('tag', '-a', 'core-v0.59.9', '-m', 'late hotfix tag', 'HEAD~1')

    commit('fix(cli): after', { 'cli/x.ts': 'v-after' })
    expect(runPush().code).toBe(0)
    expect(tags()).toContain('core-v0.60.1')
  })

  it('releases nothing when only user-owned paths changed', () => {
    commit('docs: notes', { 'docs/ADR/0007-x.md': 'notes', 'apps/portal/page.tsx': 'x' })
    const { code, out } = run()
    expect(code).toBe(0)
    expect(out).toContain('nothing to')
    expect(tags()).toEqual(['core-v0.59.3'])
  })

  it('ignores a new instance migration — user-owned inside a template-owned tree', () => {
    commit('feat(api): migration', {
      'services/api/migrations/versions/abc_add_table.py': 'revision = "abc"',
    })
    expect(run().code).toBe(0)
    expect(tags()).toEqual(['core-v0.59.3'])
  })

  it('does nothing when HEAD is already the released commit', () => {
    const { code, out } = run()
    expect(code).toBe(0)
    expect(out).toContain('already core-v0.59.3')
    expect(tags()).toEqual(['core-v0.59.3'])
  })

  it('is idempotent — a second run after a release adds no tag', () => {
    commit('fix(cli): one', { 'cli/x.ts': 'v4' })
    runPush()
    const before = tags()
    expect(runPush().code).toBe(0)
    expect(tags()).toEqual(before)
  })

  /**
   * Tags are not covered by branch protection, so this is the one hand-editing
   * fault derivation cannot rule out — and the only hard failure state left.
   */
  it('fails when the highest tag is not an ancestor of HEAD', () => {
    g('checkout', '-q', '-b', 'sidebranch')
    commit('feat(cli): off-branch', { 'cli/x.ts': 'off-branch' })
    g('tag', '-a', 'core-v0.60.0', '-m', 'off-branch')
    g('checkout', '-q', 'main')
    commit('fix(cli): on main', { 'cli/x.ts': 'v4' })

    const { code, out } = run()
    expect(code).toBe(1)
    expect(out).toContain('::error::')
    expect(out).toContain('not an ancestor of HEAD')
    expect(out).toContain('npm view @biffo/cli@0.60.0 gitHead')
    expect(tags()).not.toContain('core-v0.60.1')
  })

  it('does nothing in an instance', () => {
    commit('feat(cli): change', {
      'biffo.core.json': JSON.stringify({ version: '0.59.3' }),
      'cli/x.ts': 'v4',
    })
    const { code, out } = run()
    expect(code).toBe(0)
    expect(out).toContain('this is an instance')
    expect(tags()).toEqual(['core-v0.59.3'])
  })

  it('makes a first release when no tag exists at all', () => {
    g('tag', '-d', 'core-v0.59.3')
    const sha = commit('feat(cli): first', { 'cli/x.ts': 'v4' })
    expect(runPush().code).toBe(0)
    expect(tagged('core-v0.1.0')).toBe(sha)
  })
})

/**
 * Drift guard on the workflow that runs the above. The two properties below are
 * exactly what let #294 through, so they are asserted rather than trusted.
 */
describe('Core Version Tag workflow', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/core-tag.yml'), 'utf8')
  const trigger = workflow.split('permissions:')[0] ?? ''

  it('is not path-filtered — it has to see every push to dev', () => {
    expect(trigger).not.toMatch(/^\s*paths:/m)
  })

  it('still runs on pushes to dev and on manual dispatch', () => {
    expect(trigger).toContain('branches: [dev]')
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

  /**
   * Derivation reads the tags, so the checkout must carry them. A release job
   * that saw no tags would derive 0.1.0 over a live 0.59.x line and try to
   * publish a version npm already holds.
   */
  it('fetches tags and full history — the derivation reads both', () => {
    expect(workflow).toContain('fetch-depth: 0')
    expect(workflow).toMatch(/fetch-tags:\s*true/)
  })
})
