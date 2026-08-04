import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `js-dependency-audit.sh` and `py-dependency-audit.sh` used to sweep a FIXED
 * set of paths — the workspace root plus `_skeletons/**` — rather than
 * discovering what actually exists. In an instance with vendored plugin
 * services (`services/ideation/web/pnpm-lock.yaml`,
 * `services/idea-scout/uv.lock`) that fixed set is smaller than the real
 * tree, and the scripts printed no list of what they actually covered — so an
 * under-scan was indistinguishable from a genuine pass (#1270). Found live:
 * `services/ideation/web/pnpm-lock.yaml` sat on two advisory-range packages
 * while this exact gate stayed green.
 *
 * These tests exercise the real scripts (via `sh`, matching the CI
 * invocation `sh scripts/...`, i.e. dash) against fixture repos, with fake
 * `pnpm`/`uv` binaries on PATH so no network call or real toolchain is
 * needed. They cover the three cases #1270 asked for:
 *
 *   - a tree in a NESTED layout is discovered and printed
 *   - a tree that was never created does NOT appear in the printed list, so
 *     an omission is visible rather than inferred
 *   - discovering ZERO trees fails CLOSED (non-zero exit), matching the
 *     `ci_has()` (#1218) / `ci-wiring-audit.sh` precedent: "This audit
 *     checked nothing. That is a configuration error, not a pass."
 */

const JS_SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'js-dependency-audit.sh')
const PY_SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'py-dependency-audit.sh')

const FAKE_PNPM = `#!/bin/sh
if [ "$1" = "audit" ]; then
  echo '{"metadata":{"vulnerabilities":{"high":0,"critical":0}}}'
  exit 0
fi
exit 1
`

const FAKE_UV = `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "pip-audit" ]; then
  echo '{"dependencies":[]}'
  exit 0
fi
if [ "$1" = "export" ]; then
  echo "somepkg==1.0.0"
  exit 0
fi
exit 1
`

/** A fake-tool bin dir, prepended to PATH so the audited scripts never touch
 * the network or a real pnpm/uv registry. */
function fakeBin(): string {
  const dir = makeTmpDir('depaudit-bin')
  writeFileSync(join(dir, 'pnpm'), FAKE_PNPM)
  chmodSync(join(dir, 'pnpm'), 0o755)
  writeFileSync(join(dir, 'uv'), FAKE_UV)
  chmodSync(join(dir, 'uv'), 0o755)
  return dir
}

function gitRepo(): string {
  const dir = makeTmpDir('depaudit-repo')
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'dev'])
  return dir
}

function run(script: string, cwd: string, bin: string) {
  try {
    const stdout = execFileSync('sh', [script], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    return { code: 0, output: stdout }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, output: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

describe('js-dependency-audit.sh discovery (#1270)', () => {
  it('discovers a pnpm-lock.yaml in a nested layout, not just the workspace root', () => {
    const repo = gitRepo()
    const bin = fakeBin()
    writeFileSync(join(repo, 'pnpm-lock.yaml'), '{}')
    mkdirSync(join(repo, 'services', 'ideation', 'web'), { recursive: true })
    writeFileSync(join(repo, 'services', 'ideation', 'web', 'pnpm-lock.yaml'), '{}')

    const { code, output } = run(JS_SCRIPT, repo, bin)

    expect(code).toBe(0)
    expect(output).toContain('discovered 2 pnpm-lock.yaml tree(s)')
    expect(output).toContain('. (workspace)')
    expect(output).toContain('services/ideation/web')
  })

  it('does not claim a tree that was never created — an omission is visible, not inferred', () => {
    const repo = gitRepo()
    const bin = fakeBin()
    writeFileSync(join(repo, 'pnpm-lock.yaml'), '{}')
    // Deliberately no services/idea-scout/web/pnpm-lock.yaml here.

    const { code, output } = run(JS_SCRIPT, repo, bin)

    expect(code).toBe(0)
    expect(output).toContain('discovered 1 pnpm-lock.yaml tree(s)')
    expect(output).not.toContain('idea-scout')
  })

  it('fails CLOSED when discovery finds zero pnpm-lock.yaml trees, rather than passing silently', () => {
    const repo = gitRepo()
    const bin = fakeBin()
    writeFileSync(join(repo, 'README.md'), 'no lockfile here')

    const { code, output } = run(JS_SCRIPT, repo, bin)

    expect(code).not.toBe(0)
    expect(output).toContain('discovered ZERO')
    expect(output).toContain(
      'This audit checked nothing. That is a configuration error, not a pass',
    )
  })
})

describe('py-dependency-audit.sh discovery (#1270)', () => {
  it('discovers a uv.lock in a nested layout, not just the workspace root', () => {
    const repo = gitRepo()
    const bin = fakeBin()
    writeFileSync(join(repo, 'uv.lock'), '# lock')
    mkdirSync(join(repo, 'services', 'idea-scout'), { recursive: true })
    writeFileSync(join(repo, 'services', 'idea-scout', 'uv.lock'), '# lock')

    const { code, output } = run(PY_SCRIPT, repo, bin)

    expect(code).toBe(0)
    expect(output).toContain('discovered 2 uv.lock tree(s)')
    expect(output).toContain('. (workspace)')
    expect(output).toContain('services/idea-scout')
  })

  it('does not claim a tree that was never created — an omission is visible, not inferred', () => {
    const repo = gitRepo()
    const bin = fakeBin()
    writeFileSync(join(repo, 'uv.lock'), '# lock')
    // Deliberately no services/ideation/uv.lock here.

    const { code, output } = run(PY_SCRIPT, repo, bin)

    expect(code).toBe(0)
    expect(output).toContain('discovered 1 uv.lock tree(s)')
    expect(output).not.toContain('ideation')
  })

  it('fails CLOSED when discovery finds zero uv.lock trees, rather than passing silently', () => {
    const repo = gitRepo()
    const bin = fakeBin()
    writeFileSync(join(repo, 'README.md'), 'no lockfile here')

    const { code, output } = run(PY_SCRIPT, repo, bin)

    expect(code).not.toBe(0)
    expect(output).toContain('discovered ZERO')
    expect(output).toContain(
      'This audit checked nothing. That is a configuration error, not a pass',
    )
  })
})
