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
/**
 * Why a CI check is not in the local gate.
 *
 * ## Prose was not enough (#869, H5 gap 3)
 *
 * These were free-text sentences, and **one of eight was false for a
 * fortnight**: `bandit`'s reason claimed "the finding gate is the upload step,
 * not the run" when `bandit -ll` exits non-zero on findings and it is the run
 * step that fails. It cost an observed CI round trip (~17 min at instance
 * prices) and nothing could have caught it, because a sentence is not checkable.
 *
 * Each exclusion now carries a **kind**, and the kind is asserted mechanically:
 *
 *   network  - needs a registry or advisory database; cannot run offline
 *   pr-time  - evaluates a pull request that does not exist at push time
 *   history  - scans git history rather than the working tree
 *   slow     - too slow for a push gate, and must state a MEASURED duration
 *
 * `slow` is the one that rots, so it is the one that must carry a number: an
 * adjective ages silently while a measurement can be re-taken and disagreed
 * with. `pytest` is no longer here at all — it is included wherever it is
 * measurably fast (H5 gap 4).
 */
const EXCLUDED: Record<string, { kind: 'network' | 'pr-time' | 'history' | 'slow'; why: string }> =
  {
    'pnpm install --frozen-lockfile': { kind: 'network', why: 'dependency install, not a check' },
    'uv sync --all-groups': { kind: 'network', why: 'dependency install, not a check' },
    'pnpm --filter @biffo/portal build': {
      kind: 'slow',
      why: 'a full Next build; measured >60s in this repo, against a ~20s whole-gate budget',
    },
    'sh scripts/js-dependency-audit.sh': {
      kind: 'network',
      why: 'queries the npm advisory database',
    },
    'sh scripts/py-dependency-audit.sh': {
      kind: 'network',
      why: 'queries the PyPI advisory database',
    },
    'sh scripts/biffo.sh check release-subject': {
      kind: 'pr-time',
      why: 'validates the PR title, which does not exist at push time; exits 2 rather than passing when it cannot run',
    },
    'sh scripts/biffo.sh check ownership': {
      kind: 'pr-time',
      why: 'the CI form diffs against the PR base branch — but the check is NOT skipped locally: the commit-msg hook runs it with --staged, earlier and per-commit',
    },
    'uv run pytest --cov --cov-report=xml || [ $? -eq 5 ]': {
      kind: 'slow',
      why: 'measured 51.2s in this repo on 2026-07-29, against a 15s budget. Included automatically wherever it measures faster — 1.7-2.7s in every sibling',
    },
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

  /**
   * Compared by check KIND, not by command string.
   *
   * Exact-string matching is why this test only ever worked in the template: CI
   * runs `pnpm run lint` under `working-directory: apps/frontend` while the gate
   * runs `pnpm --dir ./apps/frontend run lint`, and `bandit -r services/api
   * services/_plugins` vs `bandit -r services`. Same check, different string.
   * A guard that only passes in one layout is the reason eight repos shipped a
   * gate that checked nothing they were written in (#855).
   *
   * `scripts/gate-coverage.sh` applies the identical normalisation across every
   * repo in the estate, which is where this comparison actually belongs; this
   * keeps the template honest in CI.
   */
  const kindOf = (cmd: string): string => {
    if (cmd.includes('run lint')) return 'lint'
    if (cmd.includes('run typecheck')) return 'typecheck'
    if (cmd.includes('run format:check')) return 'format'
    if (cmd.includes('run build') || cmd.includes('portal build')) return 'build'
    if (cmd.includes('run test')) return 'test'
    if (cmd.includes('ruff check')) return 'ruff-check'
    if (cmd.includes('ruff format')) return 'ruff-format'
    if (cmd.includes('pyright')) return 'pyright'
    if (cmd.includes('pytest')) return 'pytest'
    if (cmd.includes('bandit')) return 'bandit'
    if (cmd.includes('terraform fmt')) return 'terraform-fmt'
    if (cmd.includes('dependency-audit')) return 'audit'
    if (cmd.includes('gitleaks')) return 'gitleaks'
    if (cmd.includes('check release-subject')) return 'release-subject'
    if (cmd.includes('check ownership')) return 'ownership'
    if (cmd.includes('check plugin-terraform')) return 'plugin-terraform'
    if (cmd.includes('check plugin-collisions')) return 'plugin-collisions'
    return ''
  }

  it('runs every CI check that is not explicitly excluded', () => {
    const gateKinds = new Set(gateRuns.map(kindOf).filter(Boolean))
    const missing = ciCheckCommands()
      .filter((cmd) => !(cmd in EXCLUDED))
      .map(kindOf)
      .filter((k) => k && !gateKinds.has(k))
    expect([...new Set(missing)]).toEqual([])
  })

  it('does not carry exclusions for checks CI no longer runs', () => {
    // A stale exclusion is a claim about a check that is not there, and it
    // would silently excuse a future check that happens to share its name.
    const commands = ciCheckCommands()
    const stale = Object.keys(EXCLUDED).filter((cmd) => !commands.includes(cmd))
    expect(stale).toEqual([])
  })

  /**
   * A sentence cannot be checked, and one of these was false for a fortnight.
   * The kind is asserted instead — and `slow`, the kind that ages, must carry a
   * number so the claim can be re-measured and disagreed with.
   */
  it('justifies every exclusion mechanically, not in prose', () => {
    const KINDS = ['network', 'pr-time', 'history', 'slow']
    for (const [cmd, { kind, why }] of Object.entries(EXCLUDED)) {
      expect(KINDS, `${cmd}`).toContain(kind)
      expect(why.length, `${cmd} needs a real reason`).toBeGreaterThan(20)
      if (kind === 'slow') {
        // "too slow" is an adjective; "51.2s" is a claim someone can refute.
        expect(why, `${cmd} is excluded as slow and must state a measured duration`).toMatch(
          /\d+(\.\d+)?\s*(s|ms|min|seconds|minutes)/,
        )
      }
    }
  })

  it('does not excuse a check as slow without ever having timed it', () => {
    const slow = Object.entries(EXCLUDED).filter(([, e]) => e.kind === 'slow')
    // The failure mode this guards: adding `kind: 'slow'` to something nobody
    // timed, which is exactly how the bandit rationale got in.
    expect(slow.length).toBeGreaterThan(0)
    for (const [, e] of slow) expect(e.why).toMatch(/measured|>\d/)
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

  /**
   * `.terraform/` is a download cache of third-party modules. The two runner
   * repos hold eight vendored lambda packages in it, each declaring `lint` and
   * `test`. Linting someone else's vendored code is slow, always red, and not
   * this repo's business. It is gitignored, so a fresh worktree never has it —
   * the gap was invisible until a primary checkout was audited.
   */
  it('never walks into a vendored terraform module cache', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-tf-'))
    mkdirSync(join(dir, 'terraform', '.terraform', 'modules', 'runners', 'lambdas'), {
      recursive: true,
    })
    writeFileSync(
      join(dir, 'terraform', '.terraform', 'modules', 'runners', 'lambdas', 'package.json'),
      JSON.stringify({ name: 'vendored', scripts: { lint: 'x', test: 'x' } }),
    )
    expect(listIn(dir).join('\n')).not.toContain('vendored')
    expect(listIn(dir).filter((l) => l.includes('--dir'))).toEqual([])
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

describe('the pytest fast/slow cache', () => {
  const verify = readFileSync(join(repoRoot, 'scripts/verify.sh'), 'utf8')

  /**
   * The cache decides whether a check runs at all, so a stale one silently
   * removes a check or silently slows every push. The first version was written
   * once and read for ever (#877).
   *
   * The two directions need different mechanisms, and that asymmetry is the
   * whole design:
   *
   *   fast -> the gate RUNS the suite, so it observes the true duration every
   *           time. Recording it is free and exact; a suite that grows past the
   *           budget excludes itself on the next push.
   *   slow -> the gate never runs it, so it can never learn the suite got
   *           faster. Only age can give it a way back in.
   */
  it('records the observed duration after every real run', () => {
    expect(verify).toContain('pytest_record')
    // Both call sites — root package and nested — or one of them keeps a
    // verdict that can never be corrected.
    // Exactly two call sites — root package and nested — because one of them
    // missing keeps a verdict that can never be corrected.
    //
    // Counted over CODE lines only. The first version matched the whole file and
    // was broken by a COMMENT that mentioned the call — the same "a text match
    // can be satisfied by a comment" flaw already fixed in this file today, and
    // reintroduced three hours later in an assertion written to catch it.
    const codeLines = verify.split('\n').filter((l) => !/^\s*#/.test(l))
    const calls = codeLines.filter((l) => l.includes('pytest_record "')).length
    expect(calls).toBe(2)
    expect(verify).toContain('LAST_CHECK_SECONDS')
  })

  it('expires a measurement so a slow verdict can be retested', () => {
    expect(verify).toContain('PYTEST_MAX_AGE_DAYS')
    expect(verify).toMatch(/find "\$_cache" -mtime/)
  })

  /**
   * The cache must not live in the working tree. The first version wrote
   * `$_d/.pytest-duration` and was gitignored in biffo-template ONLY —
   * .gitignore is not a synced file, so every other repo in the estate grew an
   * untracked `?? services/api/.pytest-duration` the moment the gate ran.
   */
  it('keeps the cache out of the working tree', () => {
    expect(verify).toContain('--git-common-dir')
    expect(verify).not.toContain('"$_d/.pytest-duration"')
    const ignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8')
    expect(ignore, 'the in-tree ignore entry should be gone, not load-bearing').not.toContain(
      '.pytest-duration',
    )
  })
})

describe('--list is not truncated by an unset variable', () => {
  /**
   * `run_check` returns early in `--list` mode, so anything it would have set is
   * undefined by the time the caller reads it. `pytest_record "$d"
   * "$LAST_CHECK_SECONDS"` did exactly that, and `set -u` killed the script
   * silently, mid-list (#879).
   *
   * The damage was entirely downstream and looked like something else:
   * `gate-coverage.sh` reads `--list`, so a truncated list reads as MISSING
   * COVERAGE. tabsii-geo dropped from 8/8 to 4/8 — and only in repos where a
   * pytest measurement already existed, i.e. only after the gate had run there
   * once. A defect that appears on second use is the hardest kind to attribute.
   */
  it('defines LAST_CHECK_SECONDS before any early return can skip it', () => {
    const verify = readFileSync(join(repoRoot, 'scripts/verify.sh'), 'utf8')
    const declared = verify.indexOf('LAST_CHECK_SECONDS=""')
    const runCheck = verify.indexOf('run_check() {')
    expect(declared, 'LAST_CHECK_SECONDS must be declared').toBeGreaterThan(-1)
    // Declared at file scope, above run_check — not inside it, past the early return.
    expect(declared).toBeLessThan(runCheck)
  })

  it('lists every applicable check, not just the ones before pytest', () => {
    // The regression in one assertion: the truncated list stopped after the
    // Python block, so terraform and every JS check vanished.
    const out = execFileSync('sh', [join(repoRoot, 'scripts/verify.sh'), '--list'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(out).toContain('terraform fmt')
    expect(out).toContain('pnpm run test')
  })
})
