import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SKELETON_RULES, auditSkeleton, formatViolations } from './skeleton-drift-guard.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skeleton-drift-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function workflow(name: string, contents: string): void {
  const abs = join(root, '.github', 'workflows', name)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, contents)
}

/**
 * The directory containing `_skeletons/<name>`, found by walking up.
 *
 * **Throws when it cannot find one.** An earlier version walked up a fixed
 * number of levels, overshot to `/home`, and `auditSkeleton` returned `[]` for
 * a directory that does not exist — so the real-skeleton tests passed against
 * nothing. Reintroducing a hardcoded `runs-on: ubuntu-latest` into the actual
 * skeleton did not fail them.
 *
 * That is the same defect as #695: a guard whose expected set was empty,
 * passing against the exact bug it was written to catch. Resolution failing
 * must fail the test, not silence it.
 */
function skeletonsRoot(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, '_skeletons', name))) return join(dir, '_skeletons', name)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`could not locate _skeletons/${name} above ${fileURLToPath(import.meta.url)}`)
}

describe('runner-label rule', () => {
  /**
   * #651: a hardcoded runner bills GitHub-hosted minutes and fails immediately
   * on an account over its spending limit, so the repo cannot reach the fleet.
   */
  it('flags a job that pins a runner directly', () => {
    workflow('ci.yml', 'jobs:\n  build:\n    runs-on: ubuntu-latest\n')
    const v = auditSkeleton(root, 'test-skeleton')
    expect(v).toHaveLength(1)
    expect(v[0]!.rule).toBe('runner-label')
    expect(v[0]!.detail).toContain('ubuntu-latest')
  })

  it('accepts the RUNNER_LABEL form with a fallback', () => {
    workflow(
      'ci.yml',
      "jobs:\n  build:\n    runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}\n",
    )
    expect(auditSkeleton(root, 'test-skeleton')).toEqual([])
  })

  it('counts every offending job, not just the first', () => {
    workflow('ci.yml', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n  b:\n    runs-on: macos-14\n')
    const v = auditSkeleton(root, 'test-skeleton')
    expect(v[0]!.detail).toContain('2 job(s)')
  })
})

describe('no-gitleaks-action rule', () => {
  /**
   * #649: the action's SARIF upload assumes a GitHub-hosted $HOME and dies on
   * self-hosted runners, and it needs a paid licence for org-owned repos —
   * so every generated repo was born with a permanently red Secret Scan.
   */
  it('flags the gitleaks action', () => {
    workflow(
      'ci.yml',
      "jobs:\n  scan:\n    runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}\n    steps:\n      - uses: gitleaks/gitleaks-action@v2\n",
    )
    const v = auditSkeleton(root, 'test-skeleton')
    expect(v).toHaveLength(1)
    expect(v[0]!.rule).toBe('no-gitleaks-action')
  })

  /** The fix installs the CLI, which mentions gitleaks constantly and must pass. */
  it('accepts installing the gitleaks CLI directly', () => {
    workflow(
      'ci.yml',
      "jobs:\n  scan:\n    runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}\n    steps:\n      - name: Install gitleaks\n        run: curl -sSfL -o gitleaks.tar.gz https://github.com/gitleaks/gitleaks/releases/...\n      - run: gitleaks detect --redact -v --exit-code=2\n",
    )
    expect(auditSkeleton(root, 'test-skeleton')).toEqual([])
  })
})

describe('scope', () => {
  it('ignores files outside .github/workflows', () => {
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'notes.yml'), 'runs-on: ubuntu-latest\n')
    expect(auditSkeleton(root, 'test-skeleton')).toEqual([])
  })

  it('returns nothing for a skeleton that does not exist', () => {
    expect(auditSkeleton(join(root, 'absent'), 'gone')).toEqual([])
  })
})

describe('formatViolations', () => {
  it('carries the rationale so the fix is obvious from the failure', () => {
    workflow('ci.yml', 'jobs:\n  build:\n    runs-on: ubuntu-latest\n')
    const text = formatViolations(auditSkeleton(root, 'test-skeleton'))
    expect(text).toContain('runner-label')
    expect(text).toContain('why:')
    expect(text).toContain('#651')
  })
})

describe('the real skeletons', () => {
  /**
   * The point of the whole module: run against `_skeletons/` itself, so drift
   * fails here rather than in a repo somebody generates weeks later.
   */
  it.each(['plugin-template', 'sibling-template'])('%s holds every rule', (name) => {
    const dir = skeletonsRoot(name)
    // Prove we are auditing something real. Without this the suite passed
    // against a path that did not exist — see skeletonsRoot's note.
    expect(existsSync(join(dir, '.github', 'workflows')), `${name} has workflows`).toBe(true)
    const violations = auditSkeleton(dir, name)
    expect(formatViolations(violations)).toBe('')
    expect(violations).toEqual([])
  })

  it('every rule cites the issue that proves it matters', () => {
    for (const rule of SKELETON_RULES) {
      expect(rule.rationale, `${rule.id} must cite its evidence`).toMatch(/#\d+/)
    }
  })
})
