import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assertTargetFidelity, fidelityFailure } from './core-upgrade-target-fidelity.js'
import { applyUpgradePlan, gitMergeFile, planCoreUpgrade, type MergeEntry } from './core-upgrade.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * The reported failure (#1399) reproduced as a plan, not as a theory of one.
 *
 * `biffo core upgrade --to 0.258.0` distributed a `scripts/pg-test-db.sh` whose
 * content existed only on an unmerged branch. So the fixture is a real git repo
 * with a real `core-v0.258.0` tag, and a plan whose resolved content is the
 * *branch* version rather than the tagged one — which is exactly the shape the
 * upgrade produced, and exactly what nothing downstream could see.
 */

const TAGGED = '#!/bin/sh\n# 335-line version, as core-v0.258.0 ships it\n'
const UNMERGED = '#!/bin/sh\n# 455-line version, from an unmerged worktree branch\n'

const TAGGED_MIGRATION =
  'revision = "0001"\ndown_revision = None\n\n\ndef upgrade():\n    op.add_column("t", "real")\n'
// A body change that never landed in the tag — the same shape as #1399's
// script, but for the OTHER mechanism that carries theirsDir content into an
// instance: the additive migration carry (core-migrations.ts), which reads
// the same theirsDir and was not covered by the #1400 guard at all.
const UNMERGED_MIGRATION =
  'revision = "0001"\ndown_revision = None\n\n\ndef upgrade():\n    op.add_column("t", "unmerged")\n'
// The carry re-chains revision/down_revision on every migration it writes, so
// a legitimately-carried copy must not be flagged for THAT difference alone.
const RECHAINED_TAGGED_MIGRATION =
  'revision = "core_deadbeef"\ndown_revision = "0009"\n\n\ndef upgrade():\n    op.add_column("t", "real")\n'

function entry(over: Partial<MergeEntry> & Pick<MergeEntry, 'path' | 'status'>): MergeEntry {
  return { conflicted: false, ...over }
}

describe('assertTargetFidelity', () => {
  let repo: string
  let theirs: string

  const write = (root: string, rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }

  beforeEach(() => {
    repo = makeTmpDir('biffo-fidelity-repo')
    theirs = makeTmpDir('biffo-fidelity-theirs')
    const g = (args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    g(['init', '-q'])
    g(['config', 'user.email', 'test@example.com'])
    g(['config', 'user.name', 'Test'])
    write(repo, 'scripts/pg-test-db.sh', TAGGED)
    write(repo, 'services/api/src/app.py', 'app = 1\n')
    write(repo, 'services/api/migrations/versions/0001_create_thing.py', TAGGED_MIGRATION)
    g(['add', '-A'])
    g(['commit', '-qm', 'core'])
    g(['tag', 'core-v0.258.0'])
  })

  it('catches content that is in no tag — the #1399 failure', () => {
    // The plan resolved the unmerged branch's copy as a straight take-theirs.
    write(theirs, 'scripts/pg-test-db.sh', UNMERGED)
    const report = assertTargetFidelity({
      entries: [entry({ path: 'scripts/pg-test-db.sh', status: 'take-theirs', content: UNMERGED })],
      templateRepo: repo,
      toVersion: '0.258.0',
      theirsDir: theirs,
    })

    expect(report.unverifiable).toBeNull()
    expect(report.checked).toBe(1)
    expect(report.findings).toEqual([
      { path: 'scripts/pg-test-db.sh', reason: 'content-differs', source: 'output' },
    ])
    // The operator-facing text names the file, because "an upgrade went wrong"
    // without a path is what made this take a downstream revert to find.
    expect(fidelityFailure(report, '0.258.0')).toContain('scripts/pg-test-db.sh')
  })

  it('passes when every resolved path really is the tag', () => {
    write(theirs, 'scripts/pg-test-db.sh', TAGGED)
    const report = assertTargetFidelity({
      entries: [
        entry({ path: 'scripts/pg-test-db.sh', status: 'take-theirs', content: TAGGED }),
        entry({ path: 'services/api/src/app.py', status: 'unchanged' }),
      ],
      templateRepo: repo,
      toVersion: '0.258.0',
      theirsDir: theirs,
    })

    expect(report.findings).toEqual([])
    // The denominator is reported, so a pass cannot be confused with a no-op:
    // `unchanged` carries no upstream content and is correctly not counted.
    expect(report.checked).toBe(1)
  })

  it.each(['added', 'add-conflict', 'restored'] as const)(
    'holds %s content to the tag too — every status that copies theirs verbatim',
    (status) => {
      write(theirs, 'scripts/pg-test-db.sh', UNMERGED)
      const report = assertTargetFidelity({
        entries: [entry({ path: 'scripts/pg-test-db.sh', status, content: UNMERGED })],
        templateRepo: repo,
        toVersion: '0.258.0',
        theirsDir: theirs,
      })
      expect(report.findings).toHaveLength(1)
      expect(report.findings[0]?.source).toBe('output')
    },
  )

  it('checks the merge INPUT for a merged path, whose output legitimately differs', () => {
    // A three-way merge result is not the tag and must not be judged against it
    // — but the `theirs` side it merged FROM must be. This is the case a
    // check on output alone would miss, on exactly the diverged paths where an
    // instance's review attention is thinnest.
    write(theirs, 'scripts/pg-test-db.sh', UNMERGED)
    const report = assertTargetFidelity({
      entries: [
        entry({
          path: 'scripts/pg-test-db.sh',
          status: 'merged',
          content: 'a merge result that matches neither side\n',
        }),
      ],
      templateRepo: repo,
      toVersion: '0.258.0',
      theirsDir: theirs,
    })

    expect(report.findings).toEqual([
      { path: 'scripts/pg-test-db.sh', reason: 'content-differs', source: 'merge-input' },
    ])
  })

  it('does not judge a merged path when its input was faithful', () => {
    write(theirs, 'scripts/pg-test-db.sh', TAGGED)
    const report = assertTargetFidelity({
      entries: [
        entry({
          path: 'scripts/pg-test-db.sh',
          status: 'merged',
          content: 'merged output, deliberately unlike the tag\n',
        }),
      ],
      templateRepo: repo,
      toVersion: '0.258.0',
      theirsDir: theirs,
    })
    expect(report.findings).toEqual([])
    expect(report.checked).toBe(1)
  })

  it('flags content resolved for a path the tag does not contain at all', () => {
    write(theirs, 'scripts/invented.sh', 'echo hi\n')
    const report = assertTargetFidelity({
      entries: [entry({ path: 'scripts/invented.sh', status: 'added', content: 'echo hi\n' })],
      templateRepo: repo,
      toVersion: '0.258.0',
      theirsDir: theirs,
    })
    expect(report.findings).toEqual([
      { path: 'scripts/invented.sh', reason: 'absent-from-tag', source: 'output' },
    ])
  })

  it('reports NOT VERIFIED rather than passing when the target is an explicit checkout', () => {
    const report = assertTargetFidelity({
      entries: [entry({ path: 'scripts/pg-test-db.sh', status: 'take-theirs', content: UNMERGED })],
      templateRepo: repo,
      toVersion: '0.258.0',
      theirsDir: theirs,
      explicitTargetTree: true,
    })
    expect(report.findings).toEqual([])
    expect(report.unverifiable).toMatch(/--to-template/)
    // Zero checked, and the caller is told so — "cannot tell" is never a pass.
    expect(report.checked).toBe(0)
  })

  it('reports NOT VERIFIED rather than passing when the tag cannot be read', () => {
    const git = vi.fn(() => {
      throw new Error('fatal: not a git repository')
    })
    const report = assertTargetFidelity({
      entries: [entry({ path: 'scripts/pg-test-db.sh', status: 'take-theirs', content: UNMERGED })],
      templateRepo: '/nowhere',
      toVersion: '0.258.0',
      theirsDir: theirs,
      git,
    })
    expect(report.findings).toEqual([])
    expect(report.unverifiable).toMatch(/could not read core-v0\.258\.0/)
  })

  it('verifies a binary file by its real bytes, not a UTF-8 decode of them (#1506)', () => {
    // Pre-#1506 this test asserted the OPPOSITE: that comparing a UTF-8-mangled
    // decode of the plan's content against an equally UTF-8-mangled `git show`
    // read reported no findings, on the theory that "both sides are lossy the
    // same way" made the corruption invisible rather than a defect. That is
    // the matching-control trap — two independently wrong reads agreeing is
    // not verification. Now that `core-upgrade.ts` carries non-UTF-8 content
    // as a `Buffer` (never decoded) and this file hashes raw bytes on both
    // sides, the check is a genuine one: a `take-theirs` entry whose content
    // is the correct, byte-identical binary must report nothing wrong.
    const g = (args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41])
    writeFileSync(join(repo, 'logo.bin'), bytes)
    g(['add', '-A'])
    g(['commit', '-qm', 'binary'])
    g(['tag', 'core-v0.259.0'])

    const report = assertTargetFidelity({
      entries: [entry({ path: 'logo.bin', status: 'take-theirs', content: bytes })],
      templateRepo: repo,
      toVersion: '0.259.0',
      theirsDir: theirs,
    })
    expect(report.checked).toBe(1)
    expect(report.findings).toEqual([])
  })

  it('still catches a binary file whose resolved content genuinely differs from the tag', () => {
    // The other half of the same proof: the byte-accurate check must not have
    // traded a false positive for a false negative. A `take-theirs` entry
    // carrying the WRONG binary content is exactly the #1399 shape, applied to
    // a binary — and must be reported, not waved through because it happens
    // not to be text.
    const g = (args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    writeFileSync(join(repo, 'logo.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x41]))
    g(['add', '-A'])
    g(['commit', '-qm', 'binary'])
    g(['tag', 'core-v0.260.0'])

    const wrongBytes = Buffer.from([0xff, 0xfe, 0x00, 0x42]) // one byte off
    const report = assertTargetFidelity({
      entries: [entry({ path: 'logo.bin', status: 'take-theirs', content: wrongBytes })],
      templateRepo: repo,
      toVersion: '0.260.0',
      theirsDir: theirs,
    })
    expect(report.findings).toEqual([
      { path: 'logo.bin', reason: 'content-differs', source: 'output' },
    ])
  })

  /**
   * The real shape, end to end: `entry` comes from an actual `planCoreUpgrade`
   * run (the same call `commands/core-upgrade.ts` makes), not a hand-fed
   * `MergeEntry` — a hand-fed Buffer bypasses the exact defect this proves.
   *
   * This is the empirically-confirmed reason #1506's corruption was never
   * caught by the guard built specifically to catch a wrong-content upgrade
   * (#1399). With `core-upgrade.ts` reverted to its pre-#1506
   * `readFileSync(p, 'utf8')`, `planCoreUpgrade`'s own `entry.content` for a
   * `take-theirs` binary is a UTF-8-mangled STRING — that already disagrees
   * with the tag's blob id, but this file's OLD "already lossy" fallback
   * re-read the tag through the identical lossy `git show … {encoding:
   * 'utf8'}` path, producing the SAME mangled string from the SAME underlying
   * bytes, and concluded the two mangled reads "agreed": `report.findings`
   * came back `[]`. Verified directly, not merely reasoned about — with the
   * implementation reverted (`git stash` of `core-upgrade.ts` and this file),
   * this exact fixture produced `{ checked: 1, findings: [] }`, a clean bill
   * of health, while the file `applyUpgradePlan` actually wrote was 166 bytes
   * against a 156-byte source and failed `unzip -t`. Two independently wrong
   * reads agreeing is not verification (the matching-control trap); the
   * guard's own "no false alarm" reasoning was the mechanism hiding a real one.
   *
   * `report.findings` is `[]` in BOTH the reverted and fixed state for this
   * scenario (content genuinely matches, so `[]` is the right answer either
   * way) — which is exactly what let the old coincidence go unnoticed. The
   * fail-first signal that actually flips is the WRITTEN bytes: wrong before
   * (166 ≠ 156), correct after. That assertion is what a revert of
   * `core-upgrade.ts` alone (this file's fix left in place) fails.
   */
  it('a take-theirs binary that matches the tag is verified by real bytes, and actually lands correctly (#1506)', async () => {
    const bytes = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'modules/cloud/aws/compute/placeholder.zip',
      ),
    )
    mkdirSync(join(repo, 'services/api'), { recursive: true })
    writeFileSync(join(repo, 'services/api/asset.zip'), bytes)
    const g = (args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    g(['add', '-A'])
    g(['commit', '-qm', 'binary'])
    g(['tag', 'core-v0.262.0'])

    // theirsDir == tag exactly; base/ours both start from something else so
    // the path resolves to take-theirs — the ordinary "upstream shipped a
    // binary, the instance never touched it" case.
    const base = makeTmpDir('fidelity-base')
    const ours = makeTmpDir('fidelity-ours')
    mkdirSync(join(theirs, 'services/api'), { recursive: true })
    mkdirSync(join(base, 'services/api'), { recursive: true })
    mkdirSync(join(ours, 'services/api'), { recursive: true })
    writeFileSync(join(theirs, 'services/api/asset.zip'), bytes)
    writeFileSync(join(base, 'services/api/asset.zip'), Buffer.from([0]))
    writeFileSync(join(ours, 'services/api/asset.zip'), Buffer.from([0]))

    const instance = makeTmpDir('fidelity-apply')
    try {
      const plan = await planCoreUpgrade({
        baseDir: base,
        oursDir: ours,
        theirsDir: theirs,
        manifest: { version: 1, templateOwned: ['services/api/'], userOwned: [] },
        mergeFile: gitMergeFile,
      })
      const entry = plan.entries.find((e) => e.path === 'services/api/asset.zip')
      expect(entry?.status).toBe('take-theirs')

      const report = assertTargetFidelity({
        entries: plan.entries,
        templateRepo: repo,
        toVersion: '0.262.0',
        theirsDir: theirs,
      })
      expect(report.checked).toBe(1)
      expect(report.findings).toEqual([]) // genuinely verified now, not coincidentally

      applyUpgradePlan(instance, plan, theirs)
      const written = readFileSync(join(instance, 'services/api/asset.zip'))
      expect(written.equals(bytes)).toBe(true) // this was 166 bytes, not 156, pre-fix
    } finally {
      for (const d of [base, ours, instance]) rmSync(d, { recursive: true, force: true })
    }
  })

  describe('migration carry (#1399, second mechanism)', () => {
    // `core-migrations.ts` reads the SAME theirsDir the merge planner does, but
    // is a wholly separate carry (services/api/migrations/versions/ is
    // user-owned, so the three-way merge never touches it — see
    // core-manifest.json). Nothing in `plan.entries` mentions a migration, so
    // without an explicit `migrations` input the loop above never sees one:
    // the exact #1399 shape (unmerged theirsDir content shipped as if it were
    // the tag) is reachable through this path too, and was not checked.
    it('catches a carried migration whose body is not what the tag ships', () => {
      const report = assertTargetFidelity({
        entries: [],
        migrations: [{ file: '0001_create_thing.py', content: UNMERGED_MIGRATION }],
        templateRepo: repo,
        toVersion: '0.258.0',
        theirsDir: theirs,
      })
      expect(report.findings).toEqual([
        {
          path: 'services/api/migrations/versions/0001_create_thing.py',
          reason: 'content-differs',
          source: 'migration',
        },
      ])
      expect(report.checked).toBe(1)
    })

    it('does not flag a faithfully carried migration for its re-chained revision/down_revision', () => {
      // The carry deliberately rewrites these two lines on every migration it
      // writes (core-migrations.ts, rechainMigration) — that is not drift.
      const report = assertTargetFidelity({
        entries: [],
        migrations: [{ file: '0001_create_thing.py', content: RECHAINED_TAGGED_MIGRATION }],
        templateRepo: repo,
        toVersion: '0.258.0',
        theirsDir: theirs,
      })
      expect(report.findings).toEqual([])
      expect(report.checked).toBe(1)
    })

    it('flags a migration carried for a filename the tag does not contain', () => {
      // The shape of the ORIGINAL #1399 incident applied to a migration: a new
      // file that exists only on an unmerged branch, never merged or tagged.
      const report = assertTargetFidelity({
        entries: [],
        migrations: [{ file: '0002_invented.py', content: 'revision = "0002"\n' }],
        templateRepo: repo,
        toVersion: '0.258.0',
        theirsDir: theirs,
      })
      expect(report.findings).toEqual([
        {
          path: 'services/api/migrations/versions/0002_invented.py',
          reason: 'absent-from-tag',
          source: 'migration',
        },
      ])
    })

    it('is a no-op when the upgrade carries no migrations', () => {
      const report = assertTargetFidelity({
        entries: [],
        templateRepo: repo,
        toVersion: '0.258.0',
        theirsDir: theirs,
      })
      expect(report.findings).toEqual([])
      expect(report.checked).toBe(0)
    })
  })
})
