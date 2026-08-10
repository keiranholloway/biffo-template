// End-to-end tests: actually spawn scale-guard.mjs as a subprocess against
// on-disk fixtures, the way a consuming repo's CI would invoke it. The
// scale-guard-lib.test.mjs unit tests exercise the parsing/matching logic in
// isolation; these exist because a guard can have every pure function
// correct and still be decorative in the wiring around it (wrong exit code,
// wrong file resolved, baseline logic inverted, or -- specific to this
// relocation -- the default --tokens resolution silently pointing at the
// wrong package).
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, 'scale-guard.mjs')
const FIXTURES = join(__dirname, '__fixtures__')
const SCALE_TOKENS = join(FIXTURES, 'scale-tokens.css')
const CLEAN_FIXTURE = join(FIXTURES, 'clean-repo')
const OFF_SCALE_FIXTURE = join(FIXTURES, 'off-scale-repo')
const UNCONFIGURED_FIXTURE = join(FIXTURES, 'unconfigured-repo')
const FRESH_SIBLING_FIXTURE = join(FIXTURES, 'fresh-sibling-repo')
// This package's own real tokens.css -- today it declares no type scale at
// all, which is exactly the "no token source configured" state the
// fresh-sibling / unconfigured fixtures above are built to exercise against
// something real rather than another fixture.
const REAL_PACKAGE_TOKENS = join(__dirname, '..', 'tokens.css')

function runGuard(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' })
}

function writeBaseline(count) {
  const dir = mkdtempSync(join(tmpdir(), 'scale-guard-baseline-'))
  const file = join(dir, 'scale-guard-baseline.json')
  writeFileSync(file, JSON.stringify({ count }))
  return file
}

describe('with a configured scale (fixture tokens)', () => {
  it('CLI exits 0 on a fixture with only on-scale values (baseline 0)', () => {
    const baseline = writeBaseline(0)
    const result = runGuard(['--dir', CLEAN_FIXTURE, '--tokens', SCALE_TOKENS, '--baseline', baseline])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toMatch(/PASS -- 0 off-scale/)
    // Proves the run actually read the scale, not just returned green blind:
    // the counts line must show non-zero tokens for a configured source.
    expect(result.stdout).toMatch(/2 fontSize \/ 2 lineHeight \/ 4 spacing token\(s\)/)
    rmSync(dirname(baseline), { recursive: true })
  })

  it('CLI exits 1 on a fixture with a hardcoded off-scale font-size (baseline 0)', () => {
    const baseline = writeBaseline(0)
    const result = runGuard([
      '--dir',
      OFF_SCALE_FIXTURE,
      '--tokens',
      SCALE_TOKENS,
      '--baseline',
      baseline,
    ])
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stderr).toMatch(/FAIL -- 1 off-scale/)
    expect(result.stderr).toMatch(/font-size: 34px/)
    rmSync(dirname(baseline), { recursive: true })
  })

  it('CLI exits 0 on the off-scale fixture when the baseline already accounts for it', () => {
    const baseline = writeBaseline(1)
    const result = runGuard([
      '--dir',
      OFF_SCALE_FIXTURE,
      '--tokens',
      SCALE_TOKENS,
      '--baseline',
      baseline,
    ])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    rmSync(dirname(baseline), { recursive: true })
  })

  it('CLI exits 1 when the fixture regresses past its recorded baseline', () => {
    const baseline = writeBaseline(0) // pretend clean-repo's baseline was recorded before the regression
    const result = runGuard([
      '--dir',
      OFF_SCALE_FIXTURE,
      '--tokens',
      SCALE_TOKENS,
      '--baseline',
      baseline,
    ])
    expect(result.status, result.stdout + result.stderr).toBe(1)
    rmSync(dirname(baseline), { recursive: true })
  })

  it('CLI exits 2 (cannot tell), not 0, when no baseline file exists', () => {
    const missingBaseline = join(
      mkdtempSync(join(tmpdir(), 'scale-guard-nobaseline-')),
      'scale-guard-baseline.json',
    )
    const result = runGuard(['--dir', CLEAN_FIXTURE, '--tokens', SCALE_TOKENS, '--baseline', missingBaseline])
    expect(result.status, result.stdout + result.stderr).toBe(2)
    expect(result.stderr).toMatch(/cannot tell/)
  })

  it('CLI exits 2 (cannot tell), not 0, when the scan directory has no scannable files', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'scale-guard-empty-'))
    const baseline = writeBaseline(0)
    const result = runGuard(['--dir', emptyDir, '--tokens', SCALE_TOKENS, '--baseline', baseline])
    expect(result.status, result.stdout + result.stderr).toBe(2)
    expect(result.stderr).toMatch(/found 0 \.css\/\.tsx\/\.jsx files/)
    rmSync(emptyDir, { recursive: true })
    rmSync(dirname(baseline), { recursive: true })
  })

  it('CLI exits 2 (cannot tell), not 0, when --tokens points at nothing', () => {
    const baseline = writeBaseline(0)
    const result = runGuard([
      '--dir',
      CLEAN_FIXTURE,
      '--tokens',
      join(FIXTURES, 'does-not-exist.css'),
      '--baseline',
      baseline,
    ])
    expect(result.status, result.stdout + result.stderr).toBe(2)
    expect(result.stderr).toMatch(/cannot tell -- no tokens file/)
    rmSync(dirname(baseline), { recursive: true })
  })

  it('--init writes a baseline file with the current count and exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scale-guard-init-'))
    const baseline = join(dir, 'scale-guard-baseline.json')
    const result = runGuard([
      '--dir',
      OFF_SCALE_FIXTURE,
      '--tokens',
      SCALE_TOKENS,
      '--baseline',
      baseline,
      '--init',
    ])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const written = JSON.parse(spawnSync('cat', [baseline], { encoding: 'utf8' }).stdout)
    expect(written.count).toBe(1)
    rmSync(dir, { recursive: true })
  })
})

describe('with no scale configured (the real, current @biffo/design-tokens/tokens.css)', () => {
  it('says plainly, on a passing run, that no scale is adopted yet', () => {
    const baseline = writeBaseline(0)
    const result = runGuard([
      '--dir',
      FRESH_SIBLING_FIXTURE,
      '--tokens',
      REAL_PACKAGE_TOKENS,
      '--baseline',
      baseline,
    ])
    // A brand-new sibling's real globals.css declares nothing this guard
    // matches, so this is a genuine pass -- not skipped, not red on day one.
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toMatch(/PASS -- 0 off-scale/)
    expect(result.stdout).toMatch(/0 fontSize \/ 0 lineHeight \/ 0 spacing token\(s\)/)
    expect(result.stdout).toMatch(/No scale adopted yet in any category/)
    rmSync(dirname(baseline), { recursive: true })
  })

  it('still flags a hardcoded value with nothing to check it against -- not a free pass', () => {
    const baseline = writeBaseline(0)
    const result = runGuard([
      '--dir',
      UNCONFIGURED_FIXTURE,
      '--tokens',
      REAL_PACKAGE_TOKENS,
      '--baseline',
      baseline,
    ])
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stderr).toMatch(/FAIL -- 1 off-scale/)
    expect(result.stderr).toMatch(/font-size: 22px/)
    expect(result.stderr).toMatch(/No scale is adopted yet for at least one of these categories/)
    rmSync(dirname(baseline), { recursive: true })
  })
})
