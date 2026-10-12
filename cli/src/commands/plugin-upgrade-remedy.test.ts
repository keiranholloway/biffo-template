import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerNonInteractive } from '../lib/interactive.js'
import { pluginUpgradeCommand } from './plugin-upgrade.js'

/**
 * `plugin-staleness-report.yml` writes a refresh command into every staleness
 * issue. It once named the plugin AND `--local` (the CLI rejects that) and had
 * no `--force`, so the CLI stopped to prompt; an agent piped `yes y` into it
 * and was OOM-killed. This parses the remedy the workflow really prints
 * against the real command definition.
 */
const WORKFLOW = join(import.meta.dirname, '../../../.github/workflows/plugin-staleness-report.yml')

function workflowRemedy(repoSlug: string): string {
  const lines = readFileSync(WORKFLOW, 'utf8')
    .split('\n')
    .filter((l) => l.trim().startsWith('"npx @biffo/cli plugin upgrade'))
  expect(lines).toHaveLength(1)
  const m = /"(npx @biffo\/cli plugin upgrade[^"]*)"/.exec(lines[0] as string)
  expect(m).not.toBeNull()
  return (m as RegExpExecArray)[1]!.replace(/\$\{repo_slug\}/g, repoSlug)
}

describe('plugin-staleness remedy', () => {
  it('prints the exact non-interactive --local refresh command', () => {
    expect(workflowRemedy('biffo-plugin-idea-scout')).toBe(
      'npx @biffo/cli plugin upgrade --local ../biffo-plugin-idea-scout --force --non-interactive',
    )
  })

  it('parses against the real `plugin upgrade` definition without target, unknown options or a prompt', () => {
    registerNonInteractive(pluginUpgradeCommand) // as index.ts does for every command
    const words = workflowRemedy('biffo-plugin-idea-scout').split(/\s+/)
    const argv = words.slice(words.indexOf('upgrade') + 1)
    const { operands, unknown } = pluginUpgradeCommand.parseOptions(argv)
    const opts = pluginUpgradeCommand.opts<Record<string, unknown>>()

    expect(unknown).toEqual([]) // every option is declared by the command
    expect(operands).toEqual([]) // no target combined with --local
    expect(opts.local).toBe('../biffo-plugin-idea-scout')
    expect(Boolean(opts.force) || Boolean(opts.nonInteractive)).toBe(true) // cannot prompt
  })
})
