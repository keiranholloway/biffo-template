import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * The dependency audits must fail CLOSED, and must say what they saw (#1269).
 *
 * ## Why this exists
 *
 * Both scripts used to end an unrunnable audit with a `::warning::` and
 * **exit 0**. `biffo-plugin-ideation` rode that path on *every* run — `uv run
 * pip-audit` failed with "Failed to spawn: pip-audit" because the tool was
 * never declared — so its Python dependencies had never been scanned, and the
 * check was permanently green. Nothing distinguished that from a clean tree.
 *
 * The scripts already applied the right reasoning to `jq`: *"a deterministic
 * environment defect, not a transient registry hiccup, so it fails loudly
 * instead of degrading into a permanent pass."* It simply was not extended to
 * the audit itself.
 *
 * ## Exit 2, not 1
 *
 * "Could not determine" is a different fact from "found a real advisory".
 * Conflating them sends whoever reads the red hunting a vulnerability that may
 * not exist. Same three-valued contract as `scripts/claim.sh` (0 free / 1 taken
 * / 2 cannot tell) and `wait-for-checks.sh`. Both codes are asserted here
 * precisely, not merely as "non-zero", because the distinction is the point.
 *
 * ## Why the output assertions matter as much as the exit code
 *
 * `pnpm audit` and `pip-audit` query live sources, so a verdict is a function
 * of what had been ingested at that instant: identical trees minutes apart
 * legitimately disagreed on 2026-08-03, and a green was very nearly banked as
 * evidence a repo was clean. A bare "no advisories" is not falsifiable. A pass
 * that names the package count and the moment it asked can be checked.
 */

const JS_SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'js-dependency-audit.sh')
const PY_SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'py-dependency-audit.sh')

/** ISO-8601 UTC, as the scripts stamp it. */
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/

function bin(pnpm: string, uv: string): string {
  const dir = makeTmpDir('failclosed-bin')
  writeFileSync(join(dir, 'pnpm'), pnpm)
  chmodSync(join(dir, 'pnpm'), 0o755)
  writeFileSync(join(dir, 'uv'), uv)
  chmodSync(join(dir, 'uv'), 0o755)
  return dir
}

function repo(): string {
  const dir = makeTmpDir('failclosed-repo')
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'dev'])
  return dir
}

function run(script: string, cwd: string, binDir: string) {
  try {
    const stdout = execFileSync('sh', [script], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    })
    return { code: 0, output: stdout }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, output: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

// `pnpm audit` answering with junk — the registry-error shape, and also what a
// missing tool produces once its error text reaches stdout.
const PNPM_JUNK = `#!/bin/sh
if [ "$1" = "audit" ]; then echo 'not json at all'; exit 1; fi
exit 1
`
const PNPM_CLEAN = `#!/bin/sh
if [ "$1" = "audit" ]; then
  echo '{"metadata":{"vulnerabilities":{"info":0,"low":2,"moderate":1,"high":0,"critical":0},"totalDependencies":978}}'
  exit 0
fi
exit 1
`
const PNPM_FINDING = `#!/bin/sh
if [ "$1" = "audit" ]; then
  echo '{"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":3,"critical":1},"totalDependencies":412}}'
  exit 1
fi
exit 1
`
const UV_OK = `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "pip-audit" ]; then
  echo '{"dependencies":[{"name":"a","version":"1","vulns":[]},{"name":"b","version":"2","vulns":[]}]}'
  exit 0
fi
if [ "$1" = "export" ]; then echo "somepkg==1.0.0"; exit 0; fi
exit 1
`
// The biffo-plugin-ideation shape: uv cannot spawn pip-audit at all.
const UV_CANNOT_SPAWN = `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "pip-audit" ]; then
  echo 'error: Failed to spawn: \`pip-audit\`'
  exit 2
fi
if [ "$1" = "export" ]; then echo "somepkg==1.0.0"; exit 0; fi
exit 1
`
const UV_EXPORT_FAILS = `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "pip-audit" ]; then echo '{"dependencies":[]}'; exit 0; fi
if [ "$1" = "export" ]; then exit 1; fi
exit 1
`

describe('dependency audits fail closed (#1269)', () => {
  it('js: an unrunnable audit exits 2, not 0 — it must not read as clean', () => {
    const d = repo()
    writeFileSync(join(d, 'pnpm-lock.yaml'), '{}')
    const { code, output } = run(JS_SCRIPT, d, bin(PNPM_JUNK, UV_OK))
    expect(code, output).toBe(2)
    expect(output).toMatch(/NOT performed/i)
  })

  it('js: a real advisory still exits 1, so "found" stays distinct from "could not tell"', () => {
    const d = repo()
    writeFileSync(join(d, 'pnpm-lock.yaml'), '{}')
    const { code, output } = run(JS_SCRIPT, d, bin(PNPM_FINDING, UV_OK))
    expect(code, output).toBe(1)
  })

  it('py: uv failing to spawn pip-audit exits 2 — the biffo-plugin-ideation case', () => {
    const d = repo()
    writeFileSync(join(d, 'uv.lock'), '')
    const { code, output } = run(PY_SCRIPT, d, bin(PNPM_CLEAN, UV_CANNOT_SPAWN))
    expect(code, output).toBe(2)
    expect(output).toMatch(/NOT performed/i)
  })

  it('py: a failed requirements export exits 2 as well, not just the audit itself', () => {
    const d = repo()
    writeFileSync(join(d, 'uv.lock'), '')
    mkdirSync(join(d, '_skeletons', 'sib', 'services', 'api'), { recursive: true })
    writeFileSync(join(d, '_skeletons', 'sib', 'services', 'api', 'uv.lock'), '')
    const { code, output } = run(PY_SCRIPT, d, bin(PNPM_CLEAN, UV_EXPORT_FAILS))
    expect(code, output).toBe(2)
  })
})

describe('a passing audit states what it saw (#1269)', () => {
  it('js: names the package population, the non-blocking severities, and when it asked', () => {
    const d = repo()
    writeFileSync(join(d, 'pnpm-lock.yaml'), '{}')
    const { code, output } = run(JS_SCRIPT, d, bin(PNPM_CLEAN, UV_OK))
    expect(code, output).toBe(0)
    expect(output).toContain('978 package(s)')
    // Severities below the blocking threshold are invisible otherwise — these
    // two were genuinely present in biffo-template and had never been printed.
    expect(output).toContain('1 moderate')
    expect(output).toContain('2 low')
    expect(output).toMatch(TIMESTAMP)
  })

  it('py: names the package population and when the advisory source answered', () => {
    const d = repo()
    writeFileSync(join(d, 'uv.lock'), '')
    const { code, output } = run(PY_SCRIPT, d, bin(PNPM_CLEAN, UV_OK))
    expect(code, output).toBe(0)
    expect(output).toContain('2 package(s)')
    expect(output).toMatch(TIMESTAMP)
  })

  it('js: a bare "no advisories" with no population or stamp is not acceptable', () => {
    // Guards the regression directly: the old line was exactly
    // `${label}: no high/critical advisories.` and said nothing else.
    const d = repo()
    writeFileSync(join(d, 'pnpm-lock.yaml'), '{}')
    const { output } = run(JS_SCRIPT, d, bin(PNPM_CLEAN, UV_OK))
    expect(output).not.toMatch(/no high\/critical advisories\.\s*$/m)
  })
})
