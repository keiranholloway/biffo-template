import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const workflowDir = join(repoRoot, '.github/workflows')

/**
 * A distributed workflow must not execute anything under `cli/`.
 *
 * `.github/` is template-owned, so every workflow here ships to every instance.
 * Since #440 `cli/` does not: an instance consumes the CLI from npm and has no
 * `cli/` directory at all. A `run:` step that shells into `cli/` therefore works
 * in the template and dies in every instance — and it dies in the deploy path,
 * where it is least welcome.
 *
 * That is not hypothetical. `deploy-infra.yml` invoked
 * `cli/scripts/check-destructive-plan.mjs` in all three plan jobs, which would
 * have broken infrastructure deploys in both instances on the very next upgrade.
 * It was caught by reading a grep, not by a test, which is why this exists.
 *
 * The exemption is a workflow that skips itself in an instance — `core-tag.yml`
 * and `publish-cli.yml` both do, because releasing and publishing are the
 * template's job and no instance should attempt either.
 */
const INSTANCE_SKIP = /biffo\.core\.json/

/** Ways a workflow step can reach into the cli/ tree. */
const CLI_REFERENCE =
  /(\$GITHUB_WORKSPACE\/cli\/|(?:^|\s)(?:node|sh|bash)\s+["']?\.?\/?cli\/|pnpm\s+--filter\s+@biffo\/cli)/

describe('distributed workflows never execute out of cli/', () => {
  const workflows = readdirSync(workflowDir).filter((f) => f.endsWith('.yml'))

  it('finds workflows to check, or this guard is vacuous', () => {
    expect(workflows.length).toBeGreaterThan(3)
  })

  it.each(workflows)('%s', (file) => {
    const source = readFileSync(join(workflowDir, file), 'utf8')

    // Only `run:` lines execute; prose in a comment is free to name the path.
    const executable = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')

    if (!CLI_REFERENCE.test(executable)) return

    expect(
      INSTANCE_SKIP.test(source),
      `${file} executes something under cli/, which no instance has since #440. ` +
        'Either move the script into scripts/ (template-owned, distributed) or expose it as a ' +
        '`biffo check` subcommand — unless this workflow skips itself in an instance, which it ' +
        'does not appear to.',
    ).toBe(true)
  })

  /**
   * Negative control: the rule must be capable of failing. Without this, a
   * regex that matched nothing would leave every workflow silently exempt.
   */
  it('flags a workflow that shells into cli/ with no instance skip', () => {
    const offending =
      'jobs:\n  x:\n    steps:\n      - run: node "$GITHUB_WORKSPACE/cli/scripts/x.mjs"\n'
    expect(CLI_REFERENCE.test(offending)).toBe(true)
    expect(INSTANCE_SKIP.test(offending)).toBe(false)
  })
})
