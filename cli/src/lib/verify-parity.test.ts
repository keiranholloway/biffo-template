import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Keep the local gate a mirror of CI, not a subset of it.
 *
 * `scripts/verify.sh` exists because for months the only local gate was
 * `pyright`, and everything else was discovered by pushing — 129 failed CI runs
 * on this repo in the 30 days to 2026-07-29, ~100 of whose failing steps were
 * reproducible locally in seconds.
 *
 * A gate written once and never maintained recreates that gap silently: someone
 * adds a check to `ci.yml`, nobody adds it here, and six weeks later the local
 * run is green while CI is not. So parity is a **test**, not a convention. Add
 * a check to CI and this fails until you either put it in the gate or say, in
 * writing and with a reason, why it does not belong there.
 */
const repoRoot = join(import.meta.dirname, '..', '..', '..')
const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8')

/**
 * What the gate ACTUALLY runs here, not what its source text contains.
 *
 * The first version of this test grepped `verify.sh` for each CI command. That
 * passed for a hand-written list and broke the moment the gate started
 * assembling its checks at runtime from what the repo has — which is what makes
 * one file work in the template, instances, siblings and plugins. Worse, a
 * text match can be satisfied by a comment: the test could have gone on passing
 * while the gate ran nothing at all.
 */
const gateRuns = execFileSync('sh', [join(repoRoot, 'scripts/verify.sh'), '--list'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)

/**
 * CI steps that are deliberately NOT in the pre-push gate. Every entry needs a
 * reason, because "it was slow" and "we forgot" look identical six weeks later.
 */
const EXCLUDED: Record<string, string> = {
  'pnpm install --frozen-lockfile': 'dependency install, not a check',
  'uv sync --all-groups': 'dependency install, not a check',
  'uv run pytest --cov --cov-report=xml || [ $? -eq 5 ]':
    '56s — longer than the whole rest of the gate, and it failed once in the 30 days to 2026-07-29. CI keeps it.',
  'pnpm --filter @biffo/portal build': 'a full Next build; far too slow for every push',
  'sh scripts/js-dependency-audit.sh': 'network — advisory database lookup',
  'sh scripts/py-dependency-audit.sh': 'network — advisory database lookup',
  'sh scripts/biffo.sh check release-subject':
    'validates the PR title, which does not exist at push time',
  'sh scripts/biffo.sh check ownership':
    'diffs against the PR base branch; meaningless before a PR exists',
  'uv run bandit -r services/api services/_plugins -ll --format json -o bandit-report.json':
    'writes a report artefact CI uploads; the finding gate is the upload step, not the run',
}

/** Commands in ci.yml that are checks rather than setup or reporting. */
function ciCheckCommands(): string[] {
  const found = new Set<string>()
  for (const line of ci.split('\n')) {
    const m = line.match(/^\s*run:\s+(.*)$/)
    if (!m) continue
    const cmd = m[1].trim()
    if (/^(pnpm|uv|terraform|sh scripts\/)/.test(cmd)) found.add(cmd)
  }
  return [...found]
}

describe('verify.sh mirrors CI', () => {
  it('actually runs something — a gate that lists nothing would pass vacuously', () => {
    // The negative control. Without this, an exception or an empty --list makes
    // every assertion below trivially true, which is the fail-open shape the
    // whole practices programme exists to remove.
    expect(gateRuns.length).toBeGreaterThan(5)
  })

  /**
   * Regression: `--list` used to gate on `command -v uv` / `command -v
   * terraform`, so it reported what THIS MACHINE could run. The parity test
   * passed locally and failed on the CI runner, whose JS job has neither —
   * the gate-green/CI-red split this whole exercise exists to remove,
   * reproduced inside its own guard.
   *
   * Parity with CI is a property of the repository. What a machine happens to
   * have installed is a separate question, answered at run time by a visible
   * `n/a` line.
   */
  it('lists the same checks on a machine with no toolchain installed', () => {
    const bare = execFileSync('sh', [join(repoRoot, 'scripts/verify.sh'), '--list'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    expect(bare).toEqual(gateRuns)
  })

  it('finds the CI check commands to compare against', () => {
    // A parser that silently matches nothing would make every assertion below
    // vacuously true — the exact fail-open shape the practices work exists to
    // remove. Pin a floor.
    expect(ciCheckCommands().length).toBeGreaterThan(10)
  })

  it('runs every CI check that is not explicitly excluded', () => {
    const missing = ciCheckCommands().filter((cmd) => {
      if (cmd in EXCLUDED) return false
      return !gateRuns.includes(cmd)
    })
    expect(missing).toEqual([])
  })

  it('does not carry exclusions for checks CI no longer runs', () => {
    // A stale exclusion is a claim about a check that is not there, and it
    // would silently excuse a future check that happens to share its name.
    const commands = ciCheckCommands()
    const stale = Object.keys(EXCLUDED).filter((cmd) => !commands.includes(cmd))
    expect(stale).toEqual([])
  })

  it('gives every exclusion a reason', () => {
    for (const [cmd, reason] of Object.entries(EXCLUDED)) {
      expect(reason.length, `${cmd} needs a real reason`).toBeGreaterThan(20)
    }
  })
})

describe('verify.sh discovers JS packages that are not at the repo root', () => {
  /**
   * The bug (#852). The gate checked the repo root and nothing else. In the ten
   * estate repos with no root `package.json` — every plugin, every sibling,
   * both runner repos — it printed
   *
   *     javascript  n/a - no package.json in this repo
   *     verify passed
   *
   * on repos whose entire frontend is TypeScript. A 100% TypeScript change
   * pushed green with zero JavaScript verification, and it was found by an
   * agent noticing the gate had approved work it could not have checked.
   *
   * That is worse than the missing hooks this gate was built to fix: a repo
   * with no hooks makes no claim, this one claimed to have checked. Their CI
   * runs the same scripts with `working-directory: web` / `apps/frontend`, so
   * the checks were always applicable — the gate just looked in one place.
   */
  const repoWithNestedJs = () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-nested-'))
    for (const pkg of ['web', 'web-admin']) {
      mkdirSync(join(dir, pkg), { recursive: true })
      writeFileSync(
        join(dir, pkg, 'package.json'),
        JSON.stringify({ name: pkg, scripts: { lint: 'x', typecheck: 'x', test: 'x' } }),
      )
    }
    // node_modules must never be walked into: it is full of package.json files
    // and would turn the gate into a dependency audit.
    mkdirSync(join(dir, 'web', 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(
      join(dir, 'web', 'node_modules', 'left-pad', 'package.json'),
      JSON.stringify({ name: 'left-pad', scripts: { lint: 'x' } }),
    )
    return dir
  }

  const listIn = (cwd: string) =>
    execFileSync('sh', [join(repoRoot, 'scripts/verify.sh'), '--list'], { cwd, encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)

  it('runs each nested package’s scripts instead of reporting n/a', () => {
    const out = listIn(repoWithNestedJs())
    expect(out).toContain('pnpm --dir ./web run lint')
    expect(out).toContain('pnpm --dir ./web run typecheck')
    expect(out).toContain('pnpm --dir ./web run test')
    expect(out).toContain('pnpm --dir ./web-admin run lint')
    // The regression in one line: this used to be the entire JS section.
    expect(out.join('\n')).not.toContain('no package.json')
  })

  it('reads a minified package.json too', () => {
    // The grep was anchored to line start, so it only saw pretty-printed
    // manifests. A minified one would have reported "no lint script" — a skip
    // that reads as a considered decision rather than a parser limitation.
    const dir = mkdtempSync(join(tmpdir(), 'verify-min-'))
    mkdirSync(join(dir, 'web'), { recursive: true })
    writeFileSync(
      join(dir, 'web', 'package.json'),
      '{"name":"web","scripts":{"lint":"x","test":"x"}}',
    )
    expect(listIn(dir)).toContain('pnpm --dir ./web run lint')
  })

  it('never walks into node_modules', () => {
    expect(listIn(repoWithNestedJs()).join('\n')).not.toContain('left-pad')
  })

  it('still uses the root workspace when there is one, rather than fanning out', () => {
    // A root package.json means turbo already fans out; running per-package as
    // well would double every check in the template and both instances.
    const out = listIn(repoRoot)
    expect(out).toContain('pnpm run lint')
    expect(out.filter((l) => l.includes('--dir'))).toEqual([])
  })
})
