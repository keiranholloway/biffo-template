/**
 * The container reaper in `scripts/pg-test-db.sh` must not measure a set it has
 * quietly narrowed (#1383).
 *
 * Its scan used to be a single literal name prefix, `biffo-pg-test-`. Every test
 * container started under any other name was not merely unreaped — it was
 * outside the denominator entirely, so a clean reaper run was a true statement
 * about a set that silently excluded it. Measured on one workstation:
 * `biffo-pg-test-*` was tidy and within policy, while three Postgres containers
 * under other names had been up for **days**, one of them six. A local RLS
 * container two days stale is already priced in
 * `docs/guides/development-practices.md` at ~20m of chasing failures that
 * belonged to nobody.
 *
 * These tests drive the **real script** with a fake `docker` on PATH, because
 * the defect is in what the reaper can SEE and what it SAYS — and an assertion
 * over source text would be the substring-guard mistake #957 exists to stop.
 * The fake records every call, so "was this actually removed?" is answered by
 * the `docker rm -f` it did or did not issue, not by the wording of a message.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = join(repoRoot, 'scripts/pg-test-db.sh')

/** One row of the fake daemon's container table. */
interface FakeContainer {
  name: string
  image: string
  /** Matched by the `label=biffo.ephemeral=1` filter. */
  labelled?: boolean
  /** Container `Created` timestamp; the reaper's cutoff is 24h by default. */
  created: string
  /**
   * Value of the `biffo.checkout` label — the directory that owns the
   * container. `undefined` reproduces a container created before the label
   * existed, for which real `docker inspect` prints `<no value>`.
   */
  checkout?: string
}

const ANCIENT = '2000-01-01T00:00:00.000000000Z'
const NOW = '2999-01-01T00:00:00.000000000Z'

interface ReaperRun {
  /** Everything the script said (it writes progress to stderr). */
  said: string
  /** Container names the script actually issued `docker rm -f -v` for. */
  removed: string[]
  /** Raw `rm` argument lines, so the `-v` can be asserted rather than assumed. */
  removeCalls: string[]
}

function runReaper(containers: FakeContainer[]): ReaperRun {
  const dir = makeTmpDir('biffo-pg-reaper')
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const log = join(dir, 'calls.log')

  const rows = containers
  const nameFiltered = rows.filter((c) => c.name.startsWith('biffo-pg-test-'))
  const labelFiltered = rows.filter((c) => c.labelled === true)

  // A fake `docker` covering exactly the four verbs the reaper uses. Anything
  // else exits 0 with no output, so the script's later stages fall over quickly
  // instead of reaching for a real daemon.
  const fakeDocker = `#!/bin/sh
echo "$*" >> ${JSON.stringify(log)}
case "$1 $2" in
  "ps -a")
    case "$*" in
      *"name=biffo-pg-test-"*) printf '%b' ${JSON.stringify(nameFiltered.map((c) => `${c.name}\n`).join(''))} ;;
      *"label=biffo.ephemeral=1"*) printf '%b' ${JSON.stringify(labelFiltered.map((c) => `${c.name}\n`).join(''))} ;;
      *"{{.Names}} {{.Image}}"*) printf '%b' ${JSON.stringify(rows.map((c) => `${c.name} ${c.image}\n`).join(''))} ;;
      *) printf '%b' ${JSON.stringify(rows.map((c) => `${c.name}\n`).join(''))} ;;
    esac ;;
  "inspect -f")
    case "$*" in
      *"biffo.checkout"*)
        case "$*" in
${rows.map((c) => `          *" ${c.name}"*) echo ${JSON.stringify(c.checkout ?? '<no value>')} ;;`).join('\n')}
          *) echo "<no value>" ;;
        esac ;;
      *)
        case "$*" in
${rows.map((c) => `          *" ${c.name}"*) echo ${JSON.stringify(c.created)} ;;`).join('\n')}
          *) echo "" ;;
        esac ;;
    esac ;;
esac
exit 0
`
  writeFileSync(join(bin, 'docker'), fakeDocker)
  // Succeeds, so the script believes a server is already reachable and never
  // enters the 90s container-creation poll. The reaper has already run by then.
  writeFileSync(join(bin, 'psql'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'docker'), 0o755)
  chmodSync(join(bin, 'psql'), 0o755)

  // `spawnSync`, not `execFileSync`: the reaper writes to stderr, and
  // execFileSync surfaces stderr only when the child FAILS. Whether this script
  // fails after the reaper depends on what is installed on the machine running
  // the suite — so reading the output from the error path would make the test's
  // verdict depend on that too. This captures both streams either way.
  const result = spawnSync('sh', [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  })
  const said = String(result.stderr ?? '')
  const calls = readFileSync(log, 'utf8').split('\n')
  const removeCalls = calls.filter((l) => l.startsWith('rm -f'))
  return {
    said,
    removeCalls,
    // The NAME is whatever follows the flags. Parsed as "last field" rather
    // than by slicing a fixed prefix, so a future flag cannot silently turn
    // every assertion below into a comparison against a flag string — which is
    // exactly what adding `-v` did to the previous version of this harness.
    removed: removeCalls.map((l) => l.trim().split(/\s+/).pop() ?? ''),
  }
}

describe('pg-test-db.sh container reaper', () => {
  it('reaps a stale container found by LABEL, which the name prefix could never see', () => {
    const run = runReaper([
      {
        name: 'tabsii-rls-local',
        image: 'postgis/postgis:16-3.4',
        labelled: true,
        created: ANCIENT,
      },
    ])
    // The whole point of #1383: this container carries no `biffo-pg-test-`
    // prefix, so before the label filter it was outside the scan entirely.
    expect(run.removed).toContain('tabsii-rls-local')
  })

  it('still reaps by name prefix, for every container created before labels existed', () => {
    const run = runReaper([{ name: 'biffo-pg-test-old', image: 'postgres:16', created: ANCIENT }])
    expect(run.removed).toContain('biffo-pg-test-old')
  })

  it('leaves a container that is within the retention window', () => {
    const run = runReaper([{ name: 'biffo-pg-test-fresh', image: 'postgres:16', created: NOW }])
    expect(run.removed).toEqual([])
  })

  it('REPORTS a stale Postgres container it did not create, and does not remove it', () => {
    // The deliberate departure from the issue's preferred fix. A hand-run
    // container may hold hand-loaded data this script cannot reconstruct, so
    // the reaper's "being wrong costs four seconds" licence does not extend to
    // it. Naming it is what makes it visible; removing it would trade an
    // invisible mess for an unrecoverable one.
    const run = runReaper([{ name: 'someones-local-pg', image: 'postgres:16', created: ANCIENT }])
    expect(run.removed).toEqual([])
    expect(run.said).toContain('someones-local-pg')
    expect(run.said).toMatch(/NOT reaped/)
  })

  it('does not re-report a container it just reaped as one it cannot claim', () => {
    // Regression: `_reapable` is newline-separated, so a ` $name ` membership
    // test silently matched almost nothing and every container the script owns
    // was listed under "did not create" as well as being removed.
    const run = runReaper([
      { name: 'biffo-pg-test-old', image: 'postgres:16', created: ANCIENT },
      { name: 'labelled-old', image: 'postgres:16', labelled: true, created: ANCIENT },
    ])
    expect(run.removed.sort()).toEqual(['biffo-pg-test-old', 'labelled-old'])
    const notReaped = run.said.slice(run.said.indexOf('NOT reaped'))
    expect(notReaped).not.toContain('biffo-pg-test-old')
    expect(notReaped).not.toContain('labelled-old')
  })

  it('ignores a container that is not a Postgres image at all', () => {
    const run = runReaper([{ name: 'some-redis', image: 'redis:7', created: ANCIENT }])
    expect(run.removed).toEqual([])
    expect(run.said).not.toContain('some-redis')
  })

  it('passes -v, because removing the container without its volume is the leak', () => {
    // #1664. `docker rm -f` leaves the anonymous volume behind, so every tidy
    // reap orphaned a whole Postgres data directory. Measured on one
    // workstation: 413 dangling volumes holding 104.8GB — 95% of all local
    // volume space — against 11 live containers totalling 2.5MB. Invisible by
    // construction: `docker ps` looks clean and the reaper reports a healthy
    // count, because containers were the only thing it was ever counting.
    const run = runReaper([{ name: 'biffo-pg-test-old', image: 'postgres:16', created: ANCIENT }])
    expect(run.removed).toContain('biffo-pg-test-old')
    expect(run.removeCalls).toEqual(['rm -f -v biffo-pg-test-old'])
  })

  it('reaps a container whose checkout is GONE, however new it is', () => {
    // Age was only ever a proxy for "nobody wants this any more". Once the
    // checkout is deleted the container can never be reused by anything, so
    // the 24h wait buys nothing and costs a running Postgres competing for the
    // same page cache as the lane being timed (#703).
    const run = runReaper([
      {
        name: 'biffo-pg-test-gone',
        image: 'postgres:16',
        created: NOW,
        checkout: '/nonexistent/checkout/deleted-by-a-finished-worktree',
      },
    ])
    expect(run.removed).toContain('biffo-pg-test-gone')
    expect(run.said).toMatch(/1 whose checkout no longer exists/)
  })

  it('does NOT reap a fresh container whose checkout still exists', () => {
    // The other half, and the one that makes the rule safe to run eagerly:
    // `repoRoot` is this very checkout, so a rule that reaped it would kill a
    // lane mid-run.
    const run = runReaper([
      { name: 'biffo-pg-test-live', image: 'postgres:16', created: NOW, checkout: repoRoot },
    ])
    expect(run.removed).toEqual([])
  })

  it('keeps a container whose checkout exists even when it is ancient', () => {
    // Ownership decides, then age. An old container belonging to a live
    // checkout is still subject to the age rule — this asserts the two rules
    // compose rather than one shadowing the other.
    const run = runReaper([
      { name: 'biffo-pg-test-oldlive', image: 'postgres:16', created: ANCIENT, checkout: repoRoot },
    ])
    expect(run.removed).toContain('biffo-pg-test-oldlive')
    expect(run.said).toMatch(/0 whose checkout no longer exists, 1 unused for over/)
  })

  it('falls back to age for a container created before the checkout label existed', () => {
    // Real `docker inspect` prints `<no value>` for a missing label. Treating
    // that string as a path would make `[ ! -d ]` true and reap every
    // pre-label container on sight — the migration hazard this asserts against.
    const run = runReaper([{ name: 'biffo-pg-test-legacy', image: 'postgres:16', created: NOW }])
    expect(run.removed).toEqual([])
  })

  it('reports the denominator, not only the count removed', () => {
    // #1363: a gate that prints green over a count it never showed cannot be
    // told apart from a gate that did not run.
    const run = runReaper([
      { name: 'biffo-pg-test-a', image: 'postgres:16', created: ANCIENT },
      { name: 'biffo-pg-test-b', image: 'postgres:16', created: NOW },
    ])
    expect(run.said).toMatch(/reaped 1 of 2 container\(s\)/)
  })
})
