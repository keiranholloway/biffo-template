import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
