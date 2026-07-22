import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type CoreManifest, readCoreManifest } from './core-manifest.js'
import { type MergeFileFn, gitMergeFile, planCoreUpgrade } from './core-upgrade.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const MANIFEST: CoreManifest = {
  version: 1,
  templateOwned: ['services/api/'],
  userOwned: ['services/'],
}

// A deterministic fake merge: clean unless both non-base contents contain a
// line 'CONFLICT'. Lets the classifier be tested without invoking git.
const fakeMerge: MergeFileFn = async (_base, ours, theirs) => {
  const conflicted = ours.includes('CONFLICT') && theirs.includes('CONFLICT')
  return {
    conflicted,
    content: conflicted ? `<<<<<<<\n${ours}\n=======\n${theirs}\n>>>>>>>` : theirs,
  }
}

describe('planCoreUpgrade (classification)', () => {
  let base: string
  let ours: string
  let theirs: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'base-'))
    ours = mkdtempSync(join(tmpdir(), 'ours-'))
    theirs = mkdtempSync(join(tmpdir(), 'theirs-'))
  })
  afterEach(() => {
    for (const d of [base, ours, theirs]) rmSync(d, { recursive: true, force: true })
  })

  function w(root: string, rel: string, content: string): void {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  function plan() {
    return planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest: MANIFEST,
      mergeFile: fakeMerge,
    })
  }
  function statusOf(entries: { path: string; status: string }[], path: string): string | undefined {
    return entries.find((e) => e.path === path)?.status
  }

  it('take-theirs when the instance never diverged from base', async () => {
    w(base, 'services/api/a.py', 'v1')
    w(ours, 'services/api/a.py', 'v1')
    w(theirs, 'services/api/a.py', 'v2')
    const p = await plan()
    expect(statusOf(p.entries, 'services/api/a.py')).toBe('take-theirs')
    expect(p.conflicts).toHaveLength(0)
  })

  it('keep-ours when upstream did not change the file', async () => {
    w(base, 'services/api/a.py', 'v1')
    w(ours, 'services/api/a.py', 'local edit')
    w(theirs, 'services/api/a.py', 'v1')
    const p = await plan()
    expect(statusOf(p.entries, 'services/api/a.py')).toBe('keep-ours')
    // keep-ours is not a "change"
    expect(p.changes).toHaveLength(0)
  })

  it('keep-ours (no crash) when a template-owned path exists only in the instance', async () => {
    // Instance added its own file under a template-owned subtree — the template
    // never shipped it, so there is no base or upstream copy to merge against.
    w(ours, 'services/api/instance_only.py', 'local')
    const p = await plan()
    expect(statusOf(p.entries, 'services/api/instance_only.py')).toBe('keep-ours')
    expect(p.changes).toHaveLength(0)
    expect(p.conflicts).toHaveLength(0)
  })

  it('unchanged when ours and theirs made the identical change', async () => {
    w(base, 'services/api/a.py', 'v1')
    w(ours, 'services/api/a.py', 'v2')
    w(theirs, 'services/api/a.py', 'v2')
    const p = await plan()
    expect(statusOf(p.entries, 'services/api/a.py')).toBe('unchanged')
  })

  it('merged when both changed without overlap', async () => {
    w(base, 'services/api/a.py', 'base')
    w(ours, 'services/api/a.py', 'ours-change')
    w(theirs, 'services/api/a.py', 'theirs-change')
    const p = await plan()
    expect(statusOf(p.entries, 'services/api/a.py')).toBe('merged')
    expect(p.conflicts).toHaveLength(0)
  })

  it('conflict when both changed and the merge collides', async () => {
    w(base, 'services/api/a.py', 'base')
    w(ours, 'services/api/a.py', 'CONFLICT ours')
    w(theirs, 'services/api/a.py', 'CONFLICT theirs')
    const p = await plan()
    expect(statusOf(p.entries, 'services/api/a.py')).toBe('conflict')
    expect(p.conflicts).toHaveLength(1)
  })

  it('added when upstream introduced a new file', async () => {
    w(theirs, 'services/api/new.py', 'new')
    const p = await plan()
    expect(statusOf(p.entries, 'services/api/new.py')).toBe('added')
  })

  it('removed when upstream deleted a file the instance had not modified', async () => {
    w(base, 'services/api/gone.py', 'x')
    w(ours, 'services/api/gone.py', 'x')
    const p = await plan()
    expect(statusOf(p.entries, 'services/api/gone.py')).toBe('removed')
  })

  it('remove-conflict when upstream deleted a file the instance had modified', async () => {
    w(base, 'services/api/gone.py', 'x')
    w(ours, 'services/api/gone.py', 'x-modified')
    const p = await plan()
    expect(statusOf(p.entries, 'services/api/gone.py')).toBe('remove-conflict')
    expect(p.conflicts).toHaveLength(1)
  })

  it('ignores user-owned files entirely', async () => {
    w(base, 'services/acme-crm/p.json', '1')
    w(ours, 'services/acme-crm/p.json', '2')
    w(theirs, 'services/acme-crm/p.json', '3')
    const p = await plan()
    expect(p.entries).toHaveLength(0)
  })

  it('never carries core.version, so an upgrade cannot regress an instance lineage', async () => {
    // Uses the *real* manifest: core.version is not template-owned, so even
    // though all three trees differ on it, the plan must not mention it. An
    // instance may keep its own release lineage in that file; the version it
    // received is recorded in biffo.core.json instead.
    w(base, 'core.version', '0.4.2\n')
    w(ours, 'core.version', '0.29.1\n')
    w(theirs, 'core.version', '0.7.0\n')
    w(base, 'services/api/a.py', 'v1')
    w(theirs, 'services/api/a.py', 'v2')
    w(ours, 'services/api/a.py', 'v1')
    const p = await planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest: readCoreManifest(repoRoot),
      mergeFile: fakeMerge,
    })
    expect(p.entries.map((e) => e.path)).not.toContain('core.version')
    expect(p.changes.map((e) => e.path)).toEqual(['services/api/a.py'])
  })
})

describe('gitMergeFile (real git integration)', () => {
  it('merges non-overlapping changes cleanly', async () => {
    const base = 'l1\nl2\nl3\nl4\nl5\n'
    const ours = 'OURS\nl2\nl3\nl4\nl5\n'
    const theirs = 'l1\nl2\nl3\nl4\nTHEIRS\n'
    const { conflicted, content } = await gitMergeFile(base, ours, theirs)
    expect(conflicted).toBe(false)
    expect(content).toContain('OURS')
    expect(content).toContain('THEIRS')
  })

  it('reports a conflict with markers when changes overlap', async () => {
    const base = 'line\n'
    const ours = 'ours\n'
    const theirs = 'theirs\n'
    const { conflicted, content } = await gitMergeFile(base, ours, theirs)
    expect(conflicted).toBe(true)
    expect(content).toContain('<<<<<<<')
    expect(content).toContain('>>>>>>>')
  })

  /**
   * #392. The merged content is written verbatim into the instance, so a lost
   * trailing newline is a real defect in a real file: ruff W292 for Python,
   * prettier --check for everything else, and a spurious "\ No newline at end
   * of file" hunk in a diff someone has to review carefully.
   *
   * It survived this long because the assertions above use `toContain`, which
   * is indifferent to how the string ends. These are not.
   */
  describe('preserves the trailing newline (#392)', () => {
    it('on a clean merge', async () => {
      const { conflicted, content } = await gitMergeFile(
        'l1\nl2\nl3\n',
        'OURS\nl2\nl3\n',
        'l1\nl2\nTHEIRS\n',
      )
      expect(conflicted).toBe(false)
      expect(content.endsWith('\n')).toBe(true)
    })

    it('on a conflicted merge, whose content is written out too', async () => {
      const { conflicted, content } = await gitMergeFile('line\n', 'ours\n', 'theirs\n')
      expect(conflicted).toBe(true)
      expect(content.endsWith('\n')).toBe(true)
    })

    it('when only one side changed — the common case in an upgrade', async () => {
      // The minimal reproduction: this returned 'y' before the fix.
      const { content } = await gitMergeFile('x\n', 'x\n', 'y\n')
      expect(content).toBe('y\n')
    })

    /**
     * Preserve, not append. A file that genuinely has no trailing newline must
     * keep that shape — the fix is "stop stripping", not "always add one",
     * which would corrupt any file where the absence is deliberate.
     */
    it('and does not invent one that was never there', async () => {
      const { content } = await gitMergeFile('x', 'x', 'y')
      expect(content).toBe('y')
    })
  })
})

import { existsSync, readFileSync } from 'node:fs'
import { applyUpgradePlan, parseGitHubRepo, upgradeBranchName } from './core-upgrade.js'
import type { UpgradePlan } from './core-upgrade.js'

describe('applyUpgradePlan', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apply-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes content entries, deletes removed, and leaves keep-ours alone', () => {
    writeFileSync(join(dir, 'existing.py'), 'stays')
    mkdirSync(join(dir, 'services', 'api'), { recursive: true })
    writeFileSync(join(dir, 'services', 'api', 'gone.py'), 'old')

    const plan: UpgradePlan = {
      entries: [
        { path: 'services/api/new.py', status: 'added', conflicted: false, content: 'NEW' },
        { path: 'services/api/merged.py', status: 'merged', conflicted: false, content: 'MERGED' },
        { path: 'services/api/gone.py', status: 'removed', conflicted: false },
        { path: 'existing.py', status: 'keep-ours', conflicted: false },
      ],
      changes: [],
      conflicts: [],
      summary: {} as never,
    }

    const result = applyUpgradePlan(dir, plan)

    expect(readFileSync(join(dir, 'services/api/new.py'), 'utf8')).toBe('NEW')
    expect(readFileSync(join(dir, 'services/api/merged.py'), 'utf8')).toBe('MERGED')
    expect(existsSync(join(dir, 'services/api/gone.py'))).toBe(false)
    expect(readFileSync(join(dir, 'existing.py'), 'utf8')).toBe('stays') // untouched
    expect(result.written.sort()).toEqual(['services/api/merged.py', 'services/api/new.py'])
    expect(result.deleted).toEqual(['services/api/gone.py'])
  })

  it('writes conflict entries verbatim (markers included)', () => {
    const plan: UpgradePlan = {
      entries: [
        {
          path: 'a.py',
          status: 'conflict',
          conflicted: true,
          content: '<<<<<<<\nours\n=======\ntheirs\n>>>>>>>',
        },
      ],
      changes: [],
      conflicts: [],
      summary: {} as never,
    }
    applyUpgradePlan(dir, plan)
    expect(readFileSync(join(dir, 'a.py'), 'utf8')).toContain('<<<<<<<')
  })
})

describe('parseGitHubRepo', () => {
  it.each([
    ['git@github.com:acme/my-app.git', 'acme', 'my-app'],
    ['git@github.com:acme/my-app', 'acme', 'my-app'],
    ['https://github.com/acme/my-app.git', 'acme', 'my-app'],
    ['https://github.com/acme/my-app', 'acme', 'my-app'],
    ['https://x-access-token:TOKEN@github.com/acme/my-app.git', 'acme', 'my-app'],
  ])('parses %s', (url, owner, repo) => {
    expect(parseGitHubRepo(url)).toEqual({ owner, repo })
  })

  it('throws on an unrecognisable URL', () => {
    expect(() => parseGitHubRepo('ftp://nope')).toThrow()
  })
})

describe('upgradeBranchName', () => {
  it('builds a sanitised branch name', () => {
    expect(upgradeBranchName('0.1.0', '0.2.0')).toBe('biffo/core-upgrade-0.1.0-to-0.2.0')
  })
})
