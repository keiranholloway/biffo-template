/**
 * Pins `workflowRunCommands` against the real shipped workflows, and pins the
 * property that motivates it: a suffix-extended command must NOT satisfy the
 * assertion, where a substring test would have let it through (#718, #720).
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertInvokes, assertRunsCommand, workflowRunCommands } from './workflow-run-commands.js'

// cli/src/lib/ -> cli/src/ -> cli/ -> repo root (same derivation as check.test.ts)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('workflowRunCommands', () => {
  it('reads an inline run: scalar', () => {
    expect(workflowRunCommands('jobs:\n  a:\n    steps:\n      - run: pnpm install\n')).toEqual([
      'pnpm install',
    ])
  })

  it('splits a literal block into one command per line', () => {
    const wf = ['      - run: |', '          pnpm install', '          pnpm run build', ''].join(
      '\n',
    )
    expect(workflowRunCommands(wf)).toEqual(['pnpm install', 'pnpm run build'])
  })

  it('stops a block at the first line that dedents back to the step', () => {
    const wf = [
      '      - run: |',
      '          pnpm install',
      '      - name: next step',
      '        run: pnpm test',
    ].join('\n')
    expect(workflowRunCommands(wf)).toEqual(['pnpm install', 'pnpm test'])
  })

  it('ignores blank lines and comments inside a block', () => {
    const wf = ['      - run: |', '          pnpm install', '', '          # a note', ''].join('\n')
    expect(workflowRunCommands(wf)).toEqual(['pnpm install'])
  })

  it('skips folded scalars rather than inventing commands from their lines', () => {
    // Folding turns newlines into spaces, so per-line splitting would report
    // commands that are never run. Skipping fails closed; guessing fails open.
    const wf = ['      - run: >', '          echo one', '          echo two'].join('\n')
    expect(workflowRunCommands(wf)).toEqual([])
  })

  it('returns [] for a workflow with no run: steps, meaning "could not determine"', () => {
    expect(
      workflowRunCommands('jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n'),
    ).toEqual([])
  })

  it('finds real commands in the workflow this repo actually ships', () => {
    const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
    const commands = workflowRunCommands(ci)

    // Not an exhaustive list — the point is that parsing produced usable,
    // whole commands rather than fragments, against the live file.
    expect(commands.length).toBeGreaterThan(10)
    expect(commands.every((c) => c.trim() === c)).toBe(true)
    expect(commands).not.toContain('')
  })
})

describe('assertRunsCommand is exact where toContain was not', () => {
  const wf = ['      - run: |', '          sh scripts/biffo.sh check plugin-collisionsXX'].join(
    '\n',
  )

  it('rejects a command the workflow only *starts with* — the #720 regression', () => {
    // The substring form passes here, which is the entire defect: a guard
    // renamed by extension leaves CI running something else while the assertion
    // stays green.
    expect(wf).toContain('sh scripts/biffo.sh check plugin-collisions')

    expect(() => assertRunsCommand(wf, 'sh scripts/biffo.sh check plugin-collisions')).toThrow(
      /does not run/,
    )
  })

  it('names the near miss, so the failure explains itself', () => {
    expect(() => assertRunsCommand(wf, 'sh scripts/biffo.sh check plugin-collisions')).toThrow(
      /a substring assertion would have passed here/,
    )
  })

  it('accepts the exact command', () => {
    expect(() =>
      assertRunsCommand(wf, 'sh scripts/biffo.sh check plugin-collisionsXX'),
    ).not.toThrow()
  })

  it('says so when nothing parsed, rather than blaming the command', () => {
    expect(() => assertRunsCommand('jobs:\n  a:\n    steps:\n', 'anything')).toThrow(
      /no `run:` steps at all/,
    )
  })
})

describe('assertInvokes allows trailing arguments but not a longer name', () => {
  const hook = '  sh scripts/biffo.sh check ownership --staged "$1" || exit 1\n'

  it('accepts the command with arguments after it', () => {
    expect(() => assertInvokes(hook, 'sh scripts/biffo.sh check ownership')).not.toThrow()
  })

  it('rejects a name extended by suffix, which toContain would accept', () => {
    const renamed = hook.replace('ownership', 'ownershipXX')
    expect(renamed).toContain('sh scripts/biffo.sh check ownership')
    expect(() => assertInvokes(renamed, 'sh scripts/biffo.sh check ownership')).toThrow(
      /appears as a PREFIX/,
    )
  })
})
