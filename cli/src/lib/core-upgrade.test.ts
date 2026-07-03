import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreManifest } from './core-manifest.js'
import { type MergeFileFn, gitMergeFile, planCoreUpgrade } from './core-upgrade.js'

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
    w(base, 'services/rbac/p.json', '1')
    w(ours, 'services/rbac/p.json', '2')
    w(theirs, 'services/rbac/p.json', '3')
    const p = await plan()
    expect(p.entries).toHaveLength(0)
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
})
