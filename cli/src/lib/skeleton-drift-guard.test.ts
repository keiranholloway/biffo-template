import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

describe('hardened-dependency-audit rule', () => {
  /**
   * #591/#743: the raw command exits non-zero identically whether it found a
   * vulnerability or could not parse the registry's response, so an npm blip
   * reds a required check on every open PR at once. Both skeletons shipped it
   * for months after this repo hardened its own.
   */
  it('flags the raw pnpm audit both skeletons shipped', () => {
    workflow(
      'ci.yml',
      "jobs:\n  js:\n    runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}\n    steps:\n      - name: Dependency audit\n        run: pnpm audit --audit-level=high\n",
    )
    const v = auditSkeleton(root, 'test-skeleton')
    expect(v).toHaveLength(1)
    expect(v[0]!.rule).toBe('hardened-dependency-audit')
    expect(v[0]!.detail).toContain('js-dependency-audit.sh')
  })

  it('flags the raw pip-audit both skeletons shipped', () => {
    workflow(
      'ci.yml',
      "jobs:\n  py:\n    runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}\n    steps:\n      - run: uv run pip-audit\n",
    )
    const v = auditSkeleton(root, 'test-skeleton')
    expect(v).toHaveLength(1)
    expect(v[0]!.detail).toContain('py-dependency-audit.sh')
  })

  it('accepts the hardened wrappers, including from a nested working-directory', () => {
    workflow(
      'ci.yml',
      "jobs:\n  js:\n    runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}\n    steps:\n      - run: sh ../../scripts/js-dependency-audit.sh\n      - run: sh scripts/py-dependency-audit.sh\n",
    )
    expect(auditSkeleton(root, 'test-skeleton')).toEqual([])
  })

  /**
   * The replacement documents what it replaced on the line above it. A guard
   * that reddens on its own rationale gets deleted rather than obeyed.
   */
  it('does not flag a comment explaining which command was replaced', () => {
    workflow(
      'ci.yml',
      "jobs:\n  js:\n    runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}\n    steps:\n      # Replaces the raw `pnpm audit --audit-level=high` / `uv run pip-audit`,\n      # which cannot tell a finding from a registry error (#591).\n      - run: sh scripts/js-dependency-audit.sh\n",
    )
    expect(auditSkeleton(root, 'test-skeleton')).toEqual([])
  })

  it('counts every offending step, not just the first', () => {
    workflow(
      'ci.yml',
      "jobs:\n  a:\n    runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}\n    steps:\n      - run: pnpm audit --audit-level=high\n      - run: uv run pip-audit\n",
    )
    const v = auditSkeleton(root, 'test-skeleton')
    expect(v[0]!.detail).toContain('2 step(s)')
    expect(v[0]!.detail).toContain('js-dependency-audit.sh')
    expect(v[0]!.detail).toContain('py-dependency-audit.sh')
  })
})

describe('derived-app-title rule', () => {
  function layout(contents: string): void {
    const abs = join(root, 'apps', 'frontend', 'src', 'app', 'layout.tsx')
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, contents)
  }

  /**
   * #963: the sibling skeleton hard-coded `title: 'Sibling App'` and nothing at
   * `biffo sibling create` time touched it, so every sibling ever scaffolded
   * was born with that literal in its <title> — still visible in two of
   * tabsii's five deployed siblings' out/index.html.
   */
  it('flags the literal title the sibling skeleton shipped', () => {
    layout(
      "import type { Metadata } from 'next'\n\nexport const metadata: Metadata = {\n  title: 'Sibling App',\n}\n",
    )
    const v = auditSkeleton(root, 'test-skeleton')
    expect(v).toHaveLength(1)
    expect(v[0]!.rule).toBe('derived-app-title')
    expect(v[0]!.detail).toContain("'Sibling App'")
  })

  it('flags any hard-coded literal, not just that one string', () => {
    layout('export const metadata = {\n  title: `Some Other App`,\n}\n')
    expect(auditSkeleton(root, 'test-skeleton')).toHaveLength(1)
  })

  it('accepts a title derived from a build-time constant', () => {
    layout(
      "import { SIBLING_TITLE } from '@/lib/branding'\n\nexport const metadata = {\n  title: {\n    default: SIBLING_TITLE,\n    template: `${SIBLING_TITLE} - %s`,\n  },\n}\n",
    )
    expect(auditSkeleton(root, 'test-skeleton')).toEqual([])
  })

  it('does not flag a comment that quotes the placeholder shape it replaced', () => {
    layout(
      "import { SIBLING_TITLE } from '@/lib/branding'\n\nexport const metadata = {\n  // Was `title: 'Sibling App'` before #963 — now derived from the sibling name.\n  title: { default: SIBLING_TITLE },\n}\n",
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

  /**
   * `derived-app-title` only applies to `src/app/layout.tsx`, and only the
   * sibling skeleton has one. Assert the file exists before trusting the
   * rule's silence — the same "prove we are auditing something real" trap
   * skeletonsRoot documents.
   */
  it('audits the sibling skeleton’s real root layout', () => {
    const layout = join(
      skeletonsRoot('sibling-template'),
      'apps',
      'frontend',
      'src',
      'app',
      'layout.tsx',
    )
    expect(existsSync(layout), 'sibling-template has a root layout').toBe(true)
    const contents = readFileSync(layout, 'utf8')
    expect(contents).not.toContain("title: 'Sibling App'")
    // It derives from the sibling's own name rather than naming a title at all.
    expect(contents).toContain('SIBLING_TITLE')
  })

  it('every rule cites the issue that proves it matters', () => {
    for (const rule of SKELETON_RULES) {
      expect(rule.rationale, `${rule.id} must cite its evidence`).toMatch(/#\d+/)
    }
  })
})

describe('every repo skeleton ignores .worktrees/', () => {
  /**
   * AGENTS.md §1 mandates a worktree per unit of work under `.worktrees/`, and
   * says they are git-ignored "so worktrees never get committed or double-scanned".
   * That held in `biffo-template` and in instances, and in **none** of the eleven
   * satellites — `plugin-template` shipped no `.gitignore` at all, so every plugin
   * repo was born unable to honour the rule it also ships in its own AGENTS.md.
   *
   * The symptom was mild and permanent: three satellites read as dirty forever,
   * which trains you to ignore `git status`, and a whole worktree could be
   * committed by accident.
   */
  const skeletonsWithRepoShape = ['plugin-template', 'sibling-template']

  it.each(skeletonsWithRepoShape)('%s has a .gitignore carrying .worktrees/', (skeleton) => {
    const path = join(skeletonsRoot(skeleton), '.gitignore')
    expect(existsSync(path), `${skeleton} ships no .gitignore, so a scaffolded repo has none`).toBe(
      true,
    )
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
    expect(lines, `${skeleton}/.gitignore must ignore .worktrees/ (AGENTS.md §1)`).toContain(
      '.worktrees/',
    )
  })
})
