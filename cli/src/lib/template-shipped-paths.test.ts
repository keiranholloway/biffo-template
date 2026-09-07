import { describe, expect, it } from 'vitest'
import {
  fetchTemplateShippedPaths,
  TEMPLATE_UPSTREAM_BRANCH,
  TEMPLATE_UPSTREAM_OWNER,
  TEMPLATE_UPSTREAM_REPO,
  type GitCommandRunner,
} from './template-shipped-paths.js'

/**
 * `fetchTemplateShippedPaths` is the network-dependent half of #1912's fix, so
 * these tests never touch a real network — they drive the function through an
 * injected `GitCommandRunner`, the same pattern `core-template-trees.ts` and
 * `core-version.ts` already use for their own git-runner injection points.
 *
 * The property under test throughout: `null` means "could not tell" and must
 * be produced for EVERY failure mode, never conflated with "the template ships
 * nothing" — that conflation is precisely the fail-open shape (class #1363)
 * this fix must not introduce while closing #1362 instance #8.
 */

function recordingRunner(responses: Record<string, { stdout: string; exitCode: number | null }>): {
  runner: GitCommandRunner
  calls: string[][]
} {
  const calls: string[][] = []
  const runner: GitCommandRunner = async (args) => {
    calls.push(args)
    const key = args[0] ?? ''
    const response = responses[key]
    if (!response) throw new Error(`unexpected git subcommand in test: ${args.join(' ')}`)
    return response
  }
  return { runner, calls }
}

describe('fetchTemplateShippedPaths', () => {
  it('fetches the public template dev branch and lists its real tree, with no token', async () => {
    const { runner, calls } = recordingRunner({
      fetch: { stdout: '', exitCode: 0 },
      'ls-tree': {
        stdout: 'services/api/main.py\ncli/package.json\ndocs/ADR/0001-tenancy.md\n',
        exitCode: 0,
      },
    })

    const result = await fetchTemplateShippedPaths('/repo', runner)

    expect(result).toEqual(
      new Set(['services/api/main.py', 'cli/package.json', 'docs/ADR/0001-tenancy.md']),
    )
    // The fetch is against the real, public, unauthenticated template URL —
    // no token in the args, and the branch this repo's own ADR-0006 treats as
    // "current" (the same one `biffo core upgrade` falls back to).
    expect(calls[0]).toEqual([
      'fetch',
      '--depth',
      '1',
      '--quiet',
      `https://github.com/${TEMPLATE_UPSTREAM_OWNER}/${TEMPLATE_UPSTREAM_REPO}.git`,
      TEMPLATE_UPSTREAM_BRANCH,
    ])
    expect(calls[1]).toEqual(['ls-tree', '-r', '--name-only', 'FETCH_HEAD'])
  })

  it('returns null — not an empty set — when the fetch itself fails (offline, DNS, timeout)', async () => {
    const { runner } = recordingRunner({
      fetch: { stdout: '', exitCode: 128 },
    })
    expect(await fetchTemplateShippedPaths('/repo', runner)).toBeNull()
  })

  it('returns null when the fetch succeeds but the tree read fails', async () => {
    const { runner } = recordingRunner({
      fetch: { stdout: '', exitCode: 0 },
      'ls-tree': { stdout: '', exitCode: 1 },
    })
    expect(await fetchTemplateShippedPaths('/repo', runner)).toBeNull()
  })

  it('returns null when the runner throws (e.g. execa timeout rejecting)', async () => {
    const runner: GitCommandRunner = async () => {
      throw new Error('timed out')
    }
    expect(await fetchTemplateShippedPaths('/repo', runner)).toBeNull()
  })

  it(
    'returns null, not an empty set, when the tree comes back empty — a real template never has ' +
      'zero files, so this is treated as "could not tell" rather than "ships nothing"',
    async () => {
      const { runner } = recordingRunner({
        fetch: { stdout: '', exitCode: 0 },
        'ls-tree': { stdout: '', exitCode: 0 },
      })
      expect(await fetchTemplateShippedPaths('/repo', runner)).toBeNull()
    },
  )
})
