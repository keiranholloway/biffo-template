import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { buildCommitMessage, carriedPrsSection } from './core-upgrade.js'

/**
 * The carried-PRs provenance marker must survive a real commit, and survive
 * being read back.
 *
 * ## Why
 *
 * `biffo core upgrade --apply` could not commit its own work (#1198). The
 * marker (#767, moved into the commit message by #1011) was emitted as ONE
 * line, and commitlint's `body-max-line-length` is 100. Measured on the two
 * real upgrades run on 2026-08-03:
 *
 * | instance | carried PRs | marker length | result |
 * |---|---|---|---|
 * | tabsii-platform | 21 | 140 | commit rejected |
 * | biffo-platform | 99 | ~1000 | commit rejected |
 *
 * So the mechanism that exists to preserve provenance destroyed the commit
 * carrying it, and did so hardest on the upgrades with the most provenance —
 * the bigger the gap an instance has to close, the more certain the failure.
 *
 * The existing tests used two-PR lists (`746,750`), which is why a limit that
 * bites at ~13 was never seen. These assert a realistic worst case instead.
 *
 * ## The round-trip is the point
 *
 * Wrapping the marker is only safe if the reader follows. The parser in
 * `scripts/practices-metrics.mjs` was `([0-9,]+)`, which stops at the first
 * newline — against a wrapped marker it would still match, still return
 * numbers, and silently return only the first line of them. Under-reporting
 * that looks like working is worse than the original failure, so the guard
 * drives the writer's real output through the real parser and asserts the
 * whole list comes back.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const COMMITLINT_LIMIT = 100

/** The real parser, loaded from the script rather than reimplemented here. */
async function parseCarriedPrs(text: string): Promise<number[]> {
  const mod = await import(join(repoRoot, 'scripts/practices-metrics.mjs'))
  const fn = mod.parseCarriedPrs ?? mod.carriedPrsFromText
  expect(fn, 'practices-metrics.mjs no longer exports a carried-PRs parser').toBeTypeOf('function')
  return fn(text) as number[]
}

/** Roughly what a 30-versions-behind instance carries. */
const MANY = Array.from({ length: 120 }, (_, i) => 1000 + i)

describe('carried-prs marker', () => {
  it('keeps a short list on one line, unchanged', () => {
    const lines = carriedPrsSection([746, 750])
    expect(lines).toEqual(['', '<!-- biffo:carries-template-prs:746,750 -->'])
  })

  it('never emits a line over commitlint’s limit, however many PRs', () => {
    for (const count of [13, 21, 99, 120, 400]) {
      const prs = Array.from({ length: count }, (_, i) => 1000 + i)
      const message = buildCommitMessage('0.1.0', '0.2.0', prs)
      const tooLong = message.split('\n').filter((l) => l.length > COMMITLINT_LIMIT)
      expect(tooLong, `${count} PRs produced ${tooLong.length} over-long line(s)`).toEqual([])
    }
  })

  it('round-trips the FULL list through the real parser when wrapped', async () => {
    const message = buildCommitMessage('0.204.3', '0.228.5', MANY)
    expect(
      message.split('\n').length,
      'expected a wrapped marker for this many PRs',
    ).toBeGreaterThan(3)
    await expect(parseCarriedPrs(message)).resolves.toEqual(MANY)
  })

  it('round-trips a short, unwrapped list too', async () => {
    await expect(
      parseCarriedPrs(buildCommitMessage('0.1.0', '0.2.0', [746, 750])),
    ).resolves.toEqual([746, 750])
  })

  /**
   * The end-to-end claim: commitlint itself accepts the message. Everything
   * above reasons about a 100-character limit; this asks the tool that
   * actually rejected the commit.
   */
  it('is accepted by this repo’s own commitlint config', () => {
    const dir = makeTmpDir('biffo-carried-prs')
    const file = join(dir, 'msg.txt')
    writeFileSync(file, buildCommitMessage('0.204.3', '0.228.5', MANY))

    let failure = ''
    try {
      execFileSync('pnpm', ['exec', 'commitlint', '--edit', file], {
        cwd: repoRoot,
        stdio: 'pipe',
      })
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer }
      failure = `${String(e.stdout ?? '')}${String(e.stderr ?? '')}`
    }
    expect(failure, `commitlint rejected the generated message:\n${failure}`).toBe('')
  })

  /**
   * Guards the guard: if the marker constant ever diverges between the writer
   * and the reader, every assertion above would pass against two different
   * strings and prove nothing.
   */
  it('uses the same marker constant in the writer and the reader', () => {
    const script = readFileSync(join(repoRoot, 'scripts/practices-metrics.mjs'), 'utf8')
    const source = readFileSync(join(repoRoot, 'cli/src/commands/core-upgrade.ts'), 'utf8')
    const of = (text: string) => /CARRIED_PRS_MARKER = '([^']+)'/.exec(text)?.[1]

    expect(of(source), 'no marker constant in core-upgrade.ts').toBeTruthy()
    expect(of(script), 'writer and reader disagree on the marker string').toBe(of(source))
  })
})
