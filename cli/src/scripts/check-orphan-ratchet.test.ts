/**
 * `biffo check orphan-ratchet --instance-dir <dir>` (#1714).
 *
 * These exercise the CI entrypoint's wiring — argument handling, the
 * self-check mathematical-triviality claim the doc comment makes, the
 * denominator line, the per-file guidance, and exit codes — the same
 * discipline `check-instance-adoption.test.ts` uses for its own entrypoint.
 * The underlying orphan-detection logic (`classify`, `checkOrphanRatchet`) is
 * already tested directly in `../lib/core-upgrade.test.ts` and
 * `../lib/core-ownership-orphan-disagreement.test.ts`; this file does not
 * repeat that fixture, it proves the entrypoint calls it correctly, reports
 * honestly, and never invents a self-check default.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runOrphanRatchetCheck } from './check-orphan-ratchet.js'

/** writeFileSync does not create parent directories; every fixture path here
 * nests at least one level deep. */
function write(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

let exitCode: number | undefined

beforeEach(() => {
  vi.clearAllMocks()
  exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    throw new Error(`process.exit(${String(code)})`)
  }) as never)
})

const MANIFEST_JSON = JSON.stringify({
  version: 1,
  templateOwned: ['scripts/'],
  userOwned: ['scripts/verify.sh'],
})

/** A minimal (baseDir, theirsDir, instanceDir) trio, none of them a real git
 * worktree — `gitTrackedFiles` fails open to null for a plain tmp dir, which
 * is the same "nothing to filter" path `core-ownership-orphan-disagreement
 * .test.ts` relies on for its own fixtures. */
function buildTrees(root: string) {
  const baseDir = join(root, 'base')
  const theirsDir = join(root, 'theirs')
  const instanceDir = join(root, 'instance')
  for (const dir of [baseDir, theirsDir, instanceDir]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(theirsDir, 'core-manifest.json'), MANIFEST_JSON)
  return { baseDir, theirsDir, instanceDir }
}

describe('runOrphanRatchetCheck', () => {
  it('exits 2 when --instance-dir is EXPLICITLY given but does not exist, not a silent clean pass', async () => {
    const root = makeTmpDir('orphan-ratchet-check-missing')
    await expect(runOrphanRatchetCheck({ instanceDir: join(root, 'nowhere') })).rejects.toThrow(
      'process.exit(2)',
    )

    expect(exitCode).toBe(2)
  })

  it('with --instance-dir omitted entirely (the bare `check orphan-ratchet` CI invocation), defaults to a self-check rather than exiting 2', async () => {
    // Bare invocation: no options at all, resolving --theirs-dir (and via it,
    // --instance-dir and --base-dir) to the REAL repo root via `git
    // rev-parse --show-toplevel` — the exact shape .github/workflows/ci.yml
    // runs on every PR. Asserts it does not crash/exit and self-reports.
    await expect(runOrphanRatchetCheck({})).resolves.toBeUndefined()

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('self-check mode')
    expect(logged).toContain('no unsanctioned files')
  })

  it('a genuine self-check (instance === theirs === base) always reports zero orphans, and says so', async () => {
    const root = makeTmpDir('orphan-ratchet-check-self')
    const { theirsDir } = buildTrees(root)
    // A file that would be flagged if this tree were ever compared against a
    // GENUINELY different theirs/base — proves the zero result is because the
    // three trees are the same, not because nothing orphan-shaped exists.
    write(theirsDir, 'scripts/post-deploy-smoke.sh', '#!/bin/sh\necho smoke\n')

    await runOrphanRatchetCheck({ instanceDir: theirsDir, theirsDir, baseDir: theirsDir })

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('self-check mode')
    expect(logged).toContain('0 unsanctioned file(s)')
    expect(logged).toContain('no unsanctioned files')
  })

  it('FAILS (exit 1) against a real diverged instance tree, over a recorded baseline, naming the file and its ownership', async () => {
    const root = makeTmpDir('orphan-ratchet-check-diverged')
    const { baseDir, theirsDir, instanceDir } = buildTrees(root)
    // Present in the instance only — no base, no theirs copy — under the
    // templateOwned scripts/ prefix, with no userOwned carve-out anywhere
    // near it. The exact shape #1714 was filed over.
    write(instanceDir, 'scripts/post-deploy-smoke.sh', '#!/bin/sh\necho smoke\n')
    writeFileSync(join(instanceDir, 'biffo.orphan-baseline.json'), JSON.stringify({ count: 0 }))

    await expect(
      runOrphanRatchetCheck({ label: 'fixture-diverged', theirsDir, baseDir, instanceDir }),
    ).rejects.toThrow('process.exit(1)')

    expect(exitCode).toBe(1)
    const denom = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(denom).toContain('examined fixture-diverged')
    expect(denom).toContain('1 unsanctioned file(s)')
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('scripts/post-deploy-smoke.sh')
    expect(reported).toContain('claimed by templateOwned entry: scripts/')
    expect(reported).toContain('INCREASED over the recorded baseline')
  })

  it('does not fail when the live count is within a recorded baseline (ratchet, not a gate)', async () => {
    const root = makeTmpDir('orphan-ratchet-check-within-baseline')
    const { baseDir, theirsDir, instanceDir } = buildTrees(root)
    write(instanceDir, 'scripts/post-deploy-smoke.sh', '#!/bin/sh\necho smoke\n')
    writeFileSync(join(instanceDir, 'biffo.orphan-baseline.json'), JSON.stringify({ count: 1 }))

    await runOrphanRatchetCheck({
      label: 'fixture-within-baseline',
      theirsDir,
      baseDir,
      instanceDir,
    })

    expect(process.exit).not.toHaveBeenCalled()
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('scripts/post-deploy-smoke.sh')
    expect(reported).not.toContain('INCREASED')
  })

  it('names the nearest userOwned carve-out when one shares a leading path segment', async () => {
    const root = makeTmpDir('orphan-ratchet-check-carveout')
    const baseDir = join(root, 'base')
    const theirsDir = join(root, 'theirs')
    const instanceDir = join(root, 'instance')
    for (const dir of [baseDir, theirsDir, instanceDir]) mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(theirsDir, 'core-manifest.json'),
      JSON.stringify({
        version: 1,
        templateOwned: ['services/api/'],
        userOwned: ['services/api/tests/instance/'],
      }),
    )
    write(
      instanceDir,
      'services/api/tests/instance_helper.py',
      '# instance-only helper, wrong side of the carve-out\n',
    )

    await expect(
      runOrphanRatchetCheck({ label: 'fixture-near-carveout', theirsDir, baseDir, instanceDir }),
    ).resolves.toBeUndefined()

    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('nearest sanctioned carve-out(s): services/api/tests/instance/')
  })

  it('distinguishes should-be-upstream from should-be-in-a-carve-out when no userOwned entry is nearby (#1714)', async () => {
    // No userOwned entry anywhere in this manifest shares a leading path
    // segment with the orphan below ('scripts' vs 'docs') --
    // leadingSegmentOverlap requires shared > 0, so nearestUserOwnedEntries
    // is genuinely empty here, not merely unasserted. This is the second
    // half of #1714's recommendation ("distinguish 'should be upstream' from
    // 'should be in a carve-out' -- those need opposite actions"), and until
    // now nothing in this file exercised the branch that actually draws it.
    const root = makeTmpDir('orphan-ratchet-check-no-carveout')
    const baseDir = join(root, 'base')
    const theirsDir = join(root, 'theirs')
    const instanceDir = join(root, 'instance')
    for (const dir of [baseDir, theirsDir, instanceDir]) mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(theirsDir, 'core-manifest.json'),
      JSON.stringify({
        version: 1,
        templateOwned: ['scripts/'],
        userOwned: ['docs/ADR/'],
      }),
    )
    write(
      instanceDir,
      'scripts/post-deploy-smoke.sh',
      '#!/bin/sh\n# general-purpose tooling written in the wrong repo\n',
    )

    await expect(
      runOrphanRatchetCheck({ label: 'fixture-no-carveout', theirsDir, baseDir, instanceDir }),
    ).resolves.toBeUndefined()

    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('no userOwned entry shares any leading path segment with this file')
    expect(reported).toContain('core-manifest.json has no carve-out anywhere near it today')
    expect(reported).toContain(
      'Either this is a core capability that belongs upstream in biffo-template, or it needs ' +
        'a new carve-out declared in core-manifest.json',
    )
    // And the opposite branch's text must NOT appear -- proves this really
    // took the "no entries" path, not the carve-out path with an empty list
    // rendered oddly.
    expect(reported).not.toContain('nearest sanctioned carve-out(s)')
  })

  it('denominator counts every template-owned path examined, not just the flagged ones (#1844)', async () => {
    const root = makeTmpDir('orphan-ratchet-check-denominator')
    const { baseDir, theirsDir, instanceDir } = buildTrees(root)

    // Three template-owned paths present identically in all three trees —
    // unchanged, never flagged — plus one instance-only orphan. classify()
    // considers all 4 paths; only 1 is orphaned. A denominator line that
    // actually prints plan.orphaned.length under "examined" would read 1,
    // indistinguishable from a run that only ever considered the orphan in
    // the first place — exactly the ambiguity #1363/#1844 exist to end.
    for (const name of ['a.sh', 'b.sh', 'c.sh']) {
      const content = `#!/bin/sh\necho ${name}\n`
      write(baseDir, `scripts/${name}`, content)
      write(theirsDir, `scripts/${name}`, content)
      write(instanceDir, `scripts/${name}`, content)
    }
    write(instanceDir, 'scripts/orphan.sh', '#!/bin/sh\necho orphan\n')
    writeFileSync(join(instanceDir, 'biffo.orphan-baseline.json'), JSON.stringify({ count: 5 }))

    await runOrphanRatchetCheck({
      label: 'fixture-denominator',
      theirsDir,
      baseDir,
      instanceDir,
    })

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('examined fixture-denominator: 4 template-owned path(s) considered')
    expect(logged).toContain('1 unsanctioned file(s) found')
  })

  it('defaults the label to the basename of --instance-dir when --label is omitted', async () => {
    const root = makeTmpDir('orphan-ratchet-check-label')
    const { baseDir, theirsDir, instanceDir } = buildTrees(root)

    await runOrphanRatchetCheck({ theirsDir, baseDir, instanceDir })

    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain(`examined ${instanceDir.split('/').filter(Boolean).pop()}`)
  })
})
