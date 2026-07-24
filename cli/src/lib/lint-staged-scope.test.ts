/**
 * Guard: the pre-commit lint-staged Ruff commands must honor Ruff's own
 * `extend-exclude`.
 *
 * lint-staged passes the *explicit* paths of staged files to Ruff, and Ruff lints
 * an explicitly-named file even when it sits under `extend-exclude` — UNLESS
 * `--force-exclude` is given. Without it, staging a generated migration (excluded
 * by `[tool.ruff] extend-exclude = [..., "migrations"]`) reds the commit on code
 * the project deliberately does not lint, while CI (which invokes Ruff over the
 * tree, honoring the config) stays green — a pre-commit/CI split that blocked
 * `biffo plugin install` (its generated Alembic migration).
 *
 * So: as long as Ruff excludes anything, both lint-staged Ruff commands must carry
 * `--force-exclude`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('lint-staged Ruff honors extend-exclude', () => {
  it('runs both Ruff commands with --force-exclude when Ruff excludes any path', () => {
    const pyproject = readFileSync(join(repoRoot, 'pyproject.toml'), 'utf8')
    const excludes = /extend-exclude\s*=\s*\[([^\]]*)\]/.exec(pyproject)?.[1]?.trim() ?? ''
    // This guard only bites once there is something to exclude.
    if (excludes === '') return

    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      'lint-staged': Record<string, string[]>
    }
    const pyCommands = pkg['lint-staged']['*.py'] ?? []
    const ruffCommands = pyCommands.filter((c) => c.includes('ruff'))

    expect(ruffCommands.length).toBeGreaterThan(0)
    for (const command of ruffCommands) {
      expect(command, `${command} must carry --force-exclude`).toContain('--force-exclude')
    }
  })
})
