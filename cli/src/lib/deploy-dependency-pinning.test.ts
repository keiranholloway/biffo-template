import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Drift guard (issue #410).
 *
 * Every Lambda packaging step must install the dependency tree recorded in a
 * lockfile. None may resolve dependencies against live PyPI at deploy time.
 *
 * `uv export` re-resolves when it cannot find a lock, and silently re-locks when
 * the lock it finds has drifted from pyproject.toml. Either way the deploy ships
 * a tree nobody reviewed: two runs of identical code can produce different
 * packages, and a broken — or hostile — upstream release reaches production
 * minutes after it is published, with no gate in between.
 *
 * That is not theoretical. The core API's step ran inside the `api-service`
 * artifact, which is `services/api/` alone: it carries a pyproject.toml but no
 * uv.lock, because this is a uv workspace and the lock lives only at the repo
 * root. So it re-resolved on every single deploy. greenlet 3.5.4 was published
 * with macOS/Windows wheels and no manylinux ones; a deploy five minutes later
 * picked it up over the locked 3.5.3 and died with "no wheels with a matching
 * platform tag". An identical deploy 27 minutes earlier had succeeded — nothing
 * in the repo had changed, only PyPI.
 *
 * `--frozen` is the guard: use the lock as it stands, fail rather than resolve
 * something new. This test binds every deploy workflow to that rule at once, so
 * fixing one and forgetting another fails CI — the failure mode that let #351
 * reappear across the portal↔sibling boundary after #275 had already fixed it.
 */

const repoRoot = join(__dirname, '..', '..', '..')

const read = (p: string): string => readFileSync(join(repoRoot, p), 'utf8')

// Every workflow that packages a Python Lambda from an exported requirements file.
const lambdaPackagingWorkflows = [
  '.github/workflows/deploy-app.yml',
  '_skeletons/sibling-template/.github/workflows/deploy.yml',
]

describe.each(lambdaPackagingWorkflows)('dependency pinning in %s', (workflow) => {
  const src = read(workflow)

  // Each `uv export ...` invocation, including its backslash continuations, so a
  // flag on a wrapped line still counts as part of the same command. Anchored to
  // the start of a line so that prose mentioning the command inside a YAML
  // comment is not mistaken for an unpinned invocation.
  const exportCommands = [...src.matchAll(/^[ \t]*uv export(?:[^\n]*\\\n)*[^\n]*/gm)].map(
    (m) => m[0],
  )

  it('has at least one export command to check', () => {
    // Guards the guard: a refactor that renames the step must not turn this
    // whole file into a silent no-op.
    expect(exportCommands.length).toBeGreaterThan(0)
  })

  it('never resolves dependencies at deploy time', () => {
    const unpinned = exportCommands.filter((cmd) => !cmd.includes('--frozen'))
    expect(unpinned).toEqual([])
  })
})

describe('core API packaging exports from the workspace root lock', () => {
  const src = read('.github/workflows/deploy-app.yml')

  it('targets the root project and the biffo-api member explicitly', () => {
    // The step runs with `working-directory: api-service`, where there is no
    // lock. `--project ..` reaches the checked-out workspace root, which has
    // one; `--package biffo-api` selects this member's subtree of it. Dropping
    // either silently restores the re-resolving behaviour, because uv falls
    // back to resolving from pyproject.toml alone.
    const coreApiExports = [...src.matchAll(/^[ \t]*uv export(?:[^\n]*\\\n)*[^\n]*/gm)]
      .map((m) => m[0])
      .filter((cmd) => cmd.includes('biffo-api'))

    // dev, staging and prod each package the core API.
    expect(coreApiExports).toHaveLength(3)
    for (const cmd of coreApiExports) {
      expect(cmd).toContain('--project ..')
      expect(cmd).toContain('--frozen')
    }
  })
})
