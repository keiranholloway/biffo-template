import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { isInstanceRepo } from './core-version.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const runningInInstance = isInstanceRepo(repoRoot)
const sharedFiles = JSON.parse(readFileSync(join(repoRoot, 'shared-files.json'), 'utf8')) as {
  files: string[]
}
const SKELETONS = ['_skeletons/sibling-template', '_skeletons/plugin-template']

/**
 * Every script that has left the shared set, with the subcommand that replaced
 * it. Parameterised rather than written out per script: this suite guards the
 * mechanism that removes duplication, so duplicating it per entry would be the
 * defect it exists to catch.
 */
const RETIRED = [
  { script: 'scripts/wait-for-checks.sh', subcommand: 'wait-for-checks' },
  { script: 'scripts/branch-health.sh', subcommand: 'branch-health' },
  { script: 'scripts/claim.sh', subcommand: 'claim' },
  { script: 'scripts/hook-audit.sh', subcommand: 'hook-audit' },
  { script: 'scripts/pg-test-db.sh', subcommand: 'pg-test-db' },
  { script: 'scripts/rewrite-scope-check.sh', subcommand: 'rewrite-scope-check' },
  { script: 'scripts/gate-coverage.sh', subcommand: 'gate-coverage' },
  { script: 'scripts/verify.sh', subcommand: 'verify' },
]

/**
 * The subset AGENTS.md mandates by name. The others are invoked by tooling
 * (`verify.sh`, `.githooks/pre-push`, `practices-daily.sh`) rather than by a
 * human following the rules, so asserting they appear in AGENTS.md would fail
 * on a file that was never meant to name them.
 */
const MANDATED = ['wait-for-checks', 'branch-health', 'claim']

/**
 * Phase 0b of #1109: the first path ever to LEAVE the shared set.
 *
 * `shared-files.json` copied 16 files into 15 repos — roughly 240 copies kept
 * byte-identical by hand, with about ten estate guards written to police them.
 * `wait-for-checks.sh` now ships inside the versioned CLI package and is reached
 * through `scripts/biffo.sh`, so the copies are redundant.
 *
 * Removal and sweep are one change on purpose. Dropping a path from the list
 * only stops it being kept in step — the copies remain and drift silently,
 * unwatched, which is worse than the state being fixed.
 */
describe('wait-for-checks has left the shared set', () => {
  it.each(RETIRED)('$script is no longer distributed', ({ script }) => {
    expect(sharedFiles.files).not.toContain(script)
  })

  it.each(RETIRED)('$script is gone from both skeletons', ({ script }) => {
    for (const skeleton of SKELETONS) {
      expect(existsSync(join(repoRoot, skeleton, script)), `${skeleton} still ships a copy`).toBe(
        false,
      )
    }
  })

  it.each(RETIRED)('$script is reachable as `biffo $subcommand`', async ({ subcommand }) => {
    // Registered on the root program, or the published binary does not carry it
    // and every satellite loses the guard at once.
    const index = readFileSync(join(repoRoot, 'cli/src/index.ts'), 'utf8')
    expect(index).toContain(`${subcommand}Command`.replace(/-([a-z])/g, (_, c) => c.toUpperCase()))
  })

  it.each(RETIRED)('$script is packaged, or it breaks only on a real npm install', async () => {
    const { PACKAGED_ROOT_ASSETS } = (await import(
      join(repoRoot, 'cli/scripts/packaged-root-assets.mjs')
    )) as { PACKAGED_ROOT_ASSETS: { path: string }[] }
    const packaged = PACKAGED_ROOT_ASSETS.map((a) => a.path)
    for (const { script } of RETIRED) expect(packaged).toContain(script)
  })

  it('survives in the template, because that copy is the packaged source', () => {
    // NOT a leftover. `cli/scripts/packaged-root-assets.mjs` copies this file
    // into the tarball at prepack; deleting it would empty the package and
    // break every satellite at once.
    for (const { script } of RETIRED) expect(existsSync(join(repoRoot, script))).toBe(true)
  })
})

describe('the instructions moved before the files did', () => {
  /**
   * AGENTS.md §5 mandates this script by name. Deleting the file while the rule
   * still names it would point every agent in 14 repos at something absent —
   * and `AGENTS.md` is policy `sync`, so the stale text would be actively
   * redistributed. Order matters: instructions first, files second.
   */
  it.each([...SKELETONS.map((s) => `${s}/AGENTS.md`), 'AGENTS.md'])(
    '%s tells agents to use the bridge',
    (path) => {
      const body = readFileSync(join(repoRoot, path), 'utf8')
      for (const subcommand of MANDATED) {
        expect(body, `${path} does not route ${subcommand} through the bridge`).toContain(
          `sh scripts/biffo.sh ${subcommand}`,
        )
      }
    },
  )

  it.each(SKELETONS.map((s) => `${s}/AGENTS.md`))(
    '%s no longer tells agents to run a script the repo does not have',
    (path) => {
      const body = readFileSync(join(repoRoot, path), 'utf8')
      for (const { script } of RETIRED) expect(body).not.toContain(`sh ${script}`)
    },
  )
})

describe('a satellite that cannot resolve a version says so', () => {
  it('fails closed with an actionable message rather than exit 127', () => {
    // Before #1109 Phase 0b this fell through to `exec cli/node_modules/.bin/tsx`,
    // which does not exist outside the template: exit 127, no output, and 127 is
    // not one of the three values every caller switches on (0/1/2).
    const dir = makeTmpDir('nopin')
    spawnSync('git', ['init', '-q', dir])
    writeFileSync(join(dir, 'biffo.sibling.json'), '{}\n')

    const result = spawnSync('sh', [join(repoRoot, 'scripts/biffo.sh'), 'wait-for-checks', '1'], {
      cwd: dir,
      encoding: 'utf8',
    })

    expect(result.status).toBe(2)
    expect(`${result.stdout}${result.stderr}`).toContain('shared-sync.sh')
  })
})

describe('a sibling is born able to resolve the bridge', () => {
  it('scaffolding stamps .biffo-shared-version in the tag form shared-sync uses', () => {
    // Asserted in the source rather than by scaffolding a whole sibling: that
    // path creates a real GitHub repo and AWS resources. The two producers must
    // agree on the `core-v` prefix, or `biffo.sh` strips nothing and asks npm
    // for `@biffo/cli@core-v0.235.0`, which does not exist.
    const source = readFileSync(join(repoRoot, 'cli/src/commands/sibling-create.ts'), 'utf8')
    expect(source).toContain(".biffo-shared-version'")
    expect(source).toContain('core-v${context.templateVersion')
  })
})

describe('the callers moved with the scripts', () => {
  /**
   * These three are invoked by tooling, not by a human reading AGENTS.md, so
   * the caller is the thing that had to change. Both of these were **fail-open**
   * before: each guarded its call with `[ -f <script> ]` and carried on when the
   * file was absent — so the one repo missing the copy was the one where nothing
   * checked, and it reported success.
   */
  it('pre-push runs rewrite-scope-check through the bridge, and fails closed', () => {
    const hook = readFileSync(join(repoRoot, '.githooks/pre-push'), 'utf8')
    expect(hook).toContain('sh scripts/biffo.sh rewrite-scope-check || exit 1')
    expect(hook).not.toContain('rewrite scope NOT checked')
    expect(hook).not.toContain('[ -f scripts/rewrite-scope-check.sh ]')
  })

  it('verify.sh provisions the pg lane through the bridge', () => {
    const verify = readFileSync(join(repoRoot, 'scripts/verify.sh'), 'utf8')
    expect(verify).toContain('sh scripts/biffo.sh pg-test-db')
    expect(verify).not.toContain('[ -f scripts/pg-test-db.sh ]')
  })

  it.skipIf(runningInInstance)('practices-daily runs hook-audit through the bridge', () => {
    // practices-daily.sh is template-only as of biffo-fleet#372 (workstation
    // cron tooling with no instance caller) -- an instance's checkout no
    // longer carries it at all.
    const daily = readFileSync(join(repoRoot, 'scripts/practices-daily.sh'), 'utf8')
    expect(daily).toContain('sh scripts/biffo.sh hook-audit')
  })
})

describe('the bridge preserves the caller working directory', () => {
  /**
   * The dependency audits take their target from the working directory — a CI
   * job runs them with `working-directory: apps/frontend`. `scripts/biffo.sh`
   * normalises to the repo root, which would silently retarget them: the audit
   * would pass, having audited the wrong tree. That is a wrong ANSWER, not an
   * error, which is the failure class this whole effort keeps finding.
   */
  it('biffo.sh records where the caller stood, before it changes directory', () => {
    const bridge = readFileSync(join(repoRoot, 'scripts/biffo.sh'), 'utf8')
    const record = bridge.indexOf('BIFFO_ORIGINAL_CWD=$PWD')
    const cd = bridge.indexOf('cd "$root"')
    expect(record).toBeGreaterThan(-1)
    // Order is the whole point: recorded BEFORE the cd, or it records the root.
    expect(record).toBeLessThan(cd)
    expect(bridge).toContain('export BIFFO_ORIGINAL_CWD')
  })

  it('the command factory spawns scripts there', () => {
    const factory = readFileSync(join(repoRoot, 'cli/src/lib/packaged-script-command.ts'), 'utf8')
    expect(factory).toContain("process.env['BIFFO_ORIGINAL_CWD']")
    expect(factory).toContain('cwd')
  })

  it('shared-sync rehearsal measures with the template copy, not the satellite one', () => {
    // It runs inside each STAGED SATELLITE worktree, which no longer carries a
    // copy — so a bare `scripts/gate-coverage.sh` would report "coverage
    // unknown" for every repo and the rehearsal would stop discriminating.
    //
    // Going through the satellite's own bridge would work but would resolve
    // `npx @biffo/cli@<pin>` once per repo: 14 network round trips, and a
    // measurement that fails when the registry is unreachable.
    //
    // Invoked as a bare executable, not `sh "$TEMPLATE_ROOT/scripts/
    // gate-coverage.sh"`, since #1681: gate-coverage.sh declares
    // `#!/usr/bin/env bash`, and an explicit `sh` prefix threw that shebang
    // away. The property this test actually cares about — resolving through
    // $TEMPLATE_ROOT, not a bare satellite-relative path — is unchanged.
    const sync = readFileSync(join(repoRoot, 'scripts/shared-sync.sh'), 'utf8')
    expect(sync).toContain('"$TEMPLATE_ROOT/scripts/gate-coverage.sh"')
    expect(sync).not.toContain('cd "$wt" && sh scripts/gate-coverage.sh')
  })
})

describe('the local gate no longer passes by being absent', () => {
  /**
   * `.githooks/pre-push` used to print "no scripts/verify.sh — NO checks ran"
   * and **exit 0**. A repo without the file passed its pre-push having checked
   * nothing — one level up from #855, where eight repos ran a gate two versions
   * old and `tabsii-crm` checked one thing in eight on a 700-line change and
   * printed `verify passed`.
   *
   * With the gate inside the versioned package there is no absent case, and
   * which version a repo runs is its `.biffo-shared-version`.
   */
  it('pre-push execs the gate through the bridge', () => {
    const hook = readFileSync(join(repoRoot, '.githooks/pre-push'), 'utf8')
    expect(hook).toContain('exec sh scripts/biffo.sh verify')
  })

  it('has no branch that exits 0 because the gate is missing', () => {
    // Comments only, stripped: a comment NAMING the removed fallback is the
    // record of why it went, and asserting over prose would fail on its own
    // explanation. `ci-wiring-audit.sh` makes the same distinction — a line
    // naming a script is never a violation even when it contains the string.
    const code = readFileSync(join(repoRoot, '.githooks/pre-push'), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
    expect(code).not.toContain('NO checks ran')
    expect(code).not.toContain('[ ! -f scripts/verify.sh ]')
    // NOT a blanket `exit 0` ban: the hook legitimately exits 0 when CI is set
    // (the gate is CI's job there) and on `git rev-parse` failure. The defect
    // was exiting 0 *because the gate was missing*, which is what the two
    // assertions above pin.
  })

  it('the package.json script uses the same path, so both agree', () => {
    // Two ways to run the gate that resolve different copies is exactly the
    // drift this removes.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['verify']).toBe('sh scripts/biffo.sh verify')
  })
})
