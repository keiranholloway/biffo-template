import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type CoreManifest, readCoreManifest } from './core-manifest.js'
import {
  type MergeFileFn,
  type OrphanBaseline,
  type UpgradePlan,
  ORPHAN_BASELINE_FILE,
  applyUpgradePlan,
  checkOrphanRatchet,
  gitMergeFile,
  planCoreUpgrade,
  readOrphanBaseline,
  writeOrphanBaseline,
} from './core-upgrade.js'

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
    // This keep-ours has a template counterpart (both base and theirs ship the
    // file) — it is ordinary drift, not the #1026 orphan case below.
    expect(p.orphaned).toHaveLength(0)
  })

  it('keep-ours (no crash) when a template-owned path exists only in the instance', async () => {
    // Instance added its own file under a template-owned subtree — the template
    // never shipped it, so there is no base or upstream copy to merge against.
    w(ours, 'services/api/instance_only.py', 'local')
    const p = await plan()
    expect(statusOf(p.entries, 'services/api/instance_only.py')).toBe('keep-ours')
    expect(p.changes).toHaveLength(0)
    expect(p.conflicts).toHaveLength(0)
    // #1026: no base, no theirs — this IS the unsanctioned-orphan case the
    // upgrade report exists to surface.
    expect(p.orphaned.map((e) => e.path)).toEqual(['services/api/instance_only.py'])
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

  it('restored when the instance deleted a template-owned file the template still ships (#395)', async () => {
    w(base, 'services/api/guard.py', 'v1')
    w(theirs, 'services/api/guard.py', 'v1')
    // absent from ours — the instance deleted a template-owned file.
    const p = await plan()
    const e = p.entries.find((x) => x.path === 'services/api/guard.py')
    expect(e?.status).toBe('restored')
    expect(e?.content).toBe('v1')
    expect(p.summary.restored).toBe(1)
    expect(p.divergenceSkips).toEqual([])
  })

  it('restores the TARGET content even when upstream also changed the deleted file (#395)', async () => {
    w(base, 'services/api/guard.py', 'v1')
    w(theirs, 'services/api/guard.py', 'v2')
    const p = await plan()
    const e = p.entries.find((x) => x.path === 'services/api/guard.py')
    expect(e?.status).toBe('restored')
    expect(e?.content).toBe('v2')
  })

  it('does NOT restore a deleted file the instance declared divergent, and reports the skip (#395)', async () => {
    w(base, 'services/api/guard.py', 'v1')
    w(theirs, 'services/api/guard.py', 'v1')
    // absent from ours, but the instance declares the prefix an intentional
    // divergence — the governed way to keep a template-owned path deleted.
    w(
      ours,
      'biffo.divergence.json',
      JSON.stringify({
        warnOnly: [
          { prefix: 'services/api/guard.py', reason: 'deliberately dropped', upstream: '#395' },
        ],
      }),
    )
    const p = await plan()
    const e = p.entries.find((x) => x.path === 'services/api/guard.py')
    expect(e?.status).toBe('removed')
    expect(p.summary.restored).toBe(0)
    expect(p.divergenceSkips).toEqual(['services/api/guard.py'])
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

  it('leaves an instance-authored *.instance.yml workflow alone, and still carries ci.yml (#755)', async () => {
    // The real manifest: `.github/` is template-owned except the
    // `*.instance.yml` carve-out, so an instance's own CI lane is not even
    // enumerated, while a template-shipped workflow upgrades normally.
    w(ours, '.github/workflows/db-tests.instance.yml', 'name: db tests')
    w(base, '.github/workflows/ci.yml', 'v1')
    w(ours, '.github/workflows/ci.yml', 'v1')
    w(theirs, '.github/workflows/ci.yml', 'v2')
    const p = await planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest: readCoreManifest(repoRoot),
      mergeFile: fakeMerge,
    })
    expect(p.entries.map((e) => e.path)).not.toContain('.github/workflows/db-tests.instance.yml')
    expect(statusOf(p.entries, '.github/workflows/ci.yml')).toBe('take-theirs')
  })

  it('would keep-ours an instance workflow even without the carve-out (#755)', async () => {
    // The issue's own claim, verified: `classify()` returns keep-ours for a path
    // absent from both base and theirs, so an upgrade never touched an
    // instance-authored workflow in the first place. The carve-out is about the
    // ownership *guard* refusing the commit, not about upgrade safety — which is
    // why widening `.github/` here costs nothing at merge time.
    w(ours, '.github/workflows/db-tests.instance.yml', 'name: db tests')
    const p = await planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      // Pre-#755 ownership: `.github/` template-owned, no carve-out.
      manifest: { version: 1, templateOwned: ['.github/'], userOwned: [], released: [] },
      mergeFile: fakeMerge,
    })
    expect(statusOf(p.entries, '.github/workflows/db-tests.instance.yml')).toBe('keep-ours')
    expect(p.changes).toHaveLength(0)
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

/**
 * An executable delivered by an upgrade must arrive executable.
 *
 * `writeFileSync` creates 0644, so without mirroring the upstream mode a shell
 * script lands non-executable and every `./script.sh` in the instance dies with
 * "Permission denied". Latent for the whole life of the upgrade path: no
 * upgrade had ever *added* an executable until scripts/biffo.sh (#440), which
 * an instance's CI runs on every job. Caught in a real instance, not here.
 */
describe('applyUpgradePlan — file modes', () => {
  it('mirrors the executable bit from the upstream tree', () => {
    const theirs = mkdtempSync(join(tmpdir(), 'theirs-mode-'))
    const instance = mkdtempSync(join(tmpdir(), 'inst-mode-'))
    try {
      writeFileSync(join(theirs, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 })
      writeFileSync(join(theirs, 'plain.txt'), 'data\n', { mode: 0o644 })

      const plan: UpgradePlan = {
        entries: [
          { path: 'run.sh', status: 'added', conflicted: false, content: '#!/bin/sh\necho hi\n' },
          { path: 'plain.txt', status: 'added', conflicted: false, content: 'data\n' },
        ],
        changes: [],
        conflicts: [],
        summary: {} as UpgradePlan['summary'],
      }
      applyUpgradePlan(instance, plan, theirs)

      expect(statSync(join(instance, 'run.sh')).mode & 0o111).not.toBe(0)
      // ...and does not make everything executable.
      expect(statSync(join(instance, 'plain.txt')).mode & 0o111).toBe(0)
    } finally {
      rmSync(theirs, { recursive: true, force: true })
      rmSync(instance, { recursive: true, force: true })
    }
  })
})

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

import {
  CARRIED_PRS_MARKER,
  buildCommitMessage,
  carriedPrNumbers,
  carriedPrsSection,
} from '../commands/core-upgrade.js'

describe('carried template PRs (#767)', () => {
  it('extracts PR numbers from squash subjects', () => {
    expect(
      carriedPrNumbers([
        'feat(cli): add --json output to `biffo core diff` (#746)',
        'fix(cli): pin the ownership guard (#750)',
        'chore: something with no PR number',
      ]),
    ).toEqual([746, 750])
  })

  it('ignores a number that is not the trailing squash marker', () => {
    // "(#123)" mid-subject is a reference, not this merge's own PR.
    expect(carriedPrNumbers(['fix(api): follow up on (#123) properly (#900)'])).toEqual([900])
    expect(carriedPrNumbers(['docs: mention #123 in the guide'])).toEqual([])
  })

  it('dedupes and sorts', () => {
    expect(carriedPrNumbers(['a (#5)', 'b (#3)', 'c (#5)'])).toEqual([3, 5])
  })

  it('emits a machine-readable marker, hidden from the reader', () => {
    const out = carriedPrsSection([750, 746, 746])
    expect(out.join('\n')).toContain(`<!-- ${CARRIED_PRS_MARKER}746,750 -->`)
  })

  it('emits nothing at all when there is nothing to record', () => {
    // An upgrade that cannot read the template history must add no noise, and
    // must not emit an empty marker that a parser would read as "carried none".
    expect(carriedPrsSection([])).toEqual([])
  })
})

describe('buildCommitMessage carries the same marker as the PR body (#1011)', () => {
  it('embeds the marker in the commit message when PRs were carried', () => {
    const message = buildCommitMessage('0.152.0', '0.155.0', [750, 746])
    expect(message).toContain(`<!-- ${CARRIED_PRS_MARKER}746,750 -->`)
  })

  it('keeps the subject as the first line, blank line, then the marker', () => {
    // `--apply` can commit and then fail at the push step, aborting before the
    // PR is ever opened (#1011). This commit is made first, so a hand-created
    // PR from it still carries the marker only if it survives being embedded
    // in the message itself — not appended after it in some form a hand-made
    // PR wouldn't reproduce.
    const message = buildCommitMessage('0.1.0', '0.2.0', [5])
    expect(message.split('\n')).toEqual([
      'chore(core): upgrade template core 0.1.0 -> 0.2.0',
      '',
      `<!-- ${CARRIED_PRS_MARKER}5 -->`,
    ])
  })

  it('adds no marker at all when nothing was carried', () => {
    const message = buildCommitMessage('0.1.0', '0.2.0', [])
    expect(message).toBe('chore(core): upgrade template core 0.1.0 -> 0.2.0')
    expect(message).not.toContain(CARRIED_PRS_MARKER)
  })
})

describe('planCoreUpgrade reads the template as a git tree, not a directory (#1006)', () => {
  let base: string
  let ours: string
  let theirs: string

  function git(repo: string, args: string[]): void {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
  }
  function w(root: string, rel: string, content: string): void {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'base-'))
    ours = mkdtempSync(join(tmpdir(), 'ours-'))
    // The target tree is a live template checkout, which is what the fast path
    // ("the target IS this checkout's latest tag") and --to-template both hand
    // the planner.
    theirs = mkdtempSync(join(tmpdir(), 'theirs-'))
    git(theirs, ['init', '--quiet'])
  })
  afterEach(() => {
    for (const d of [base, ours, theirs]) rmSync(d, { recursive: true, force: true })
  })

  function plan() {
    return planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest: MANIFEST,
      mergeFile: fakeMerge,
    })
  }

  it('does not propose a gitignored build artifact under a template-owned prefix', async () => {
    // Exactly the report: `core upgrade` against biffo-platform proposed
    // `added apps/portal/tsconfig.tsbuildinfo` and two `.terraform.lock.hcl`
    // files. All three are gitignored and absent from origin/dev — they exist
    // only because the operator had run a build and a `terraform init`.
    w(theirs, '.gitignore', '*.tsbuildinfo\n.terraform.lock.hcl\n')
    w(theirs, 'services/api/real.py', 'shipped upstream')
    git(theirs, ['add', '-A'])
    w(theirs, 'services/api/tsconfig.tsbuildinfo', 'LOCAL BUILD OUTPUT')
    w(theirs, 'services/api/.terraform.lock.hcl', 'LOCAL TERRAFORM INIT')

    const p = await plan()
    expect(p.changes.map((c) => c.path)).toEqual(['services/api/real.py'])
  })

  it('does not propose an untracked file even when nothing ignores it', async () => {
    w(theirs, 'services/api/real.py', 'shipped upstream')
    git(theirs, ['add', '-A'])
    w(theirs, 'services/api/scratch.py', 'never committed')

    const p = await plan()
    expect(p.changes.map((c) => c.path)).toEqual(['services/api/real.py'])
  })

  it('still carries every tracked template-owned file', async () => {
    // The filter must narrow to the git tree, not to the diff — a genuinely
    // new upstream file has to keep arriving.
    w(theirs, 'services/api/a.py', 'v2')
    w(theirs, 'services/api/new.py', 'brand new')
    git(theirs, ['add', '-A'])
    w(base, 'services/api/a.py', 'v1')
    w(ours, 'services/api/a.py', 'v1')

    const p = await plan()
    expect(p.changes.map((c) => c.path).sort()).toEqual([
      'services/api/a.py',
      'services/api/new.py',
    ])
  })

  it('ignores untracked files in the merge base tree too', async () => {
    // A stale artifact in the BASE checkout is just as fabricated: it makes a
    // file look like something upstream deleted, so the upgrade proposes a
    // deletion the instance never asked for.
    git(base, ['init', '--quiet'])
    w(base, 'services/api/a.py', 'v1')
    git(base, ['add', '-A'])
    w(base, 'services/api/tsconfig.tsbuildinfo', 'LOCAL BUILD OUTPUT')
    w(ours, 'services/api/a.py', 'v1')
    w(ours, 'services/api/tsconfig.tsbuildinfo', 'instance build output')
    w(theirs, 'services/api/a.py', 'v1')
    git(theirs, ['add', '-A'])

    const p = await plan()
    expect(p.changes).toEqual([])
  })

  it('leaves the instance tree unfiltered — the merge sees it as it is', async () => {
    // The instance is a git repo too, but its working tree is the one thing the
    // three-way merge must read literally, so an instance-side edit still wins
    // as keep-ours rather than being invisible.
    git(ours, ['init', '--quiet'])
    w(base, 'services/api/a.py', 'v1')
    w(theirs, 'services/api/a.py', 'v1')
    git(theirs, ['add', '-A'])
    w(ours, 'services/api/a.py', 'local edit, never committed')

    const p = await plan()
    expect(p.entries.find((e) => e.path === 'services/api/a.py')?.status).toBe('keep-ours')
  })
})

describe('planCoreUpgrade orphan report (#1026)', () => {
  let base: string
  let ours: string
  let theirs: string

  function git(repo: string, args: string[]): void {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
  }
  function w(root: string, rel: string, content: string): void {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'base-'))
    ours = mkdtempSync(join(tmpdir(), 'ours-'))
    theirs = mkdtempSync(join(tmpdir(), 'theirs-'))
  })
  afterEach(() => {
    for (const d of [base, ours, theirs]) rmSync(d, { recursive: true, force: true })
  })

  function plan() {
    return planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest: MANIFEST,
      mergeFile: fakeMerge,
    })
  }

  it('excludes a gitignored file from the orphan report', async () => {
    // A build artifact left inside a template-owned prefix (#1006's exact
    // shape, applied to the orphan report) — it must not inflate the count an
    // instance is ratcheted against.
    git(ours, ['init', '--quiet'])
    w(ours, '.gitignore', '*.tsbuildinfo\n')
    w(ours, 'services/api/real_instance_file.py', 'a genuinely orphaned file')
    git(ours, ['add', '-A'])
    w(ours, 'services/api/build.tsbuildinfo', 'BUILD ARTIFACT')

    const p = await plan()
    expect(p.orphaned.map((e) => e.path)).toEqual(['services/api/real_instance_file.py'])
  })

  it('excludes an untracked-but-not-ignored file too', async () => {
    git(ours, ['init', '--quiet'])
    w(ours, 'services/api/real_instance_file.py', 'a genuinely orphaned file')
    git(ours, ['add', '-A'])
    w(ours, 'services/api/scratch.py', 'never committed')

    const p = await plan()
    expect(p.orphaned.map((e) => e.path)).toEqual(['services/api/real_instance_file.py'])
  })

  it('does not filter anything when oursDir is not a git repo', async () => {
    // The fail-open contract `gitTrackedFiles` already has: unable to answer
    // the question means nothing is excluded, matching the merge's own
    // unfiltered read of `oursDir` (#1006's comment on `planCoreUpgrade`).
    w(ours, 'services/api/whatever.py', 'not even a repo here')
    const p = await plan()
    expect(p.orphaned.map((e) => e.path)).toEqual(['services/api/whatever.py'])
  })

  it('carves an instance-sanctioned path out of the report entirely, via the real manifest', async () => {
    // End-to-end proof of the #1026 manifest change: a test the instance
    // writes under the sanctioned carve-out never even reaches classify() as
    // template-owned, so it cannot appear as an orphan.
    const manifest = readCoreManifest(repoRoot)
    w(ours, 'services/api/tests/instance/test_tabsii_router.py', 'def test(): pass')
    const p = await planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest,
      mergeFile: fakeMerge,
    })
    expect(p.orphaned).toEqual([])
    expect(p.entries.map((e) => e.path)).not.toContain(
      'services/api/tests/instance/test_tabsii_router.py',
    )
  })
})

describe('orphan baseline (#1026)', () => {
  let instance: string

  beforeEach(() => {
    instance = mkdtempSync(join(tmpdir(), 'orphan-baseline-'))
  })
  afterEach(() => {
    rmSync(instance, { recursive: true, force: true })
  })

  it('reads null when no baseline file exists yet', () => {
    expect(readOrphanBaseline(instance)).toBeNull()
  })

  it('round-trips a written baseline', () => {
    writeOrphanBaseline(instance, 18)
    const baseline: OrphanBaseline | null = readOrphanBaseline(instance)
    expect(baseline).toEqual({ count: 18 })
  })

  it('throws on a malformed baseline file rather than silently treating it as absent', () => {
    writeFileSync(join(instance, ORPHAN_BASELINE_FILE), 'not json at all')
    expect(() => readOrphanBaseline(instance)).toThrow(/not valid JSON/)
  })

  it('throws when the shape is wrong (negative count)', () => {
    writeFileSync(join(instance, ORPHAN_BASELINE_FILE), JSON.stringify({ count: -1 }))
    expect(() => readOrphanBaseline(instance)).toThrow(/invalid/)
  })
})

describe('checkOrphanRatchet (#1026)', () => {
  it('never fails when no baseline has been established yet', () => {
    const r = checkOrphanRatchet(45, null)
    expect(r).toEqual({ count: 45, baseline: null, increased: false })
  })

  it('does not fail when the count matches the baseline', () => {
    const r = checkOrphanRatchet(18, { count: 18 })
    expect(r.increased).toBe(false)
  })

  it('does not fail when the count dropped below the baseline', () => {
    // Cleanup is credited automatically here — the ratchet just never fails,
    // it does not require re-recording a lower baseline to stay green.
    const r = checkOrphanRatchet(10, { count: 18 })
    expect(r.increased).toBe(false)
  })

  it('fails when the count exceeds the baseline', () => {
    const r = checkOrphanRatchet(19, { count: 18 })
    expect(r).toEqual({ count: 19, baseline: 18, increased: true })
  })
})
