/**
 * Drift guard for the Secret Scan history pass (issue #258).
 *
 * The Secret Scan job checks out with `fetch-depth: 0`, which fetches *every*
 * remote ref rather than only the one being built. gitleaks' default git-log
 * arguments include `--all`, so without an explicit `--log-opts` the history
 * scan covers commits that exist only on unmerged branches: a single bad commit
 * on anyone's open branch reddens the integration branch and every open PR at
 * once, with nothing in the built ref's history responsible for it.
 *
 * `--log-opts="--full-history HEAD"` scopes the walk to commits reachable from
 * the ref under test. It is a *scoping* change, not a weakening one — the whole
 * reachable history is still walked, so a secret committed and then removed
 * within the branch is still caught (proven empirically in the PR that added
 * this file), and on `pull_request` HEAD is the merge commit so the PR's own
 * commits stay in scope.
 *
 * These assertions couple the two workflows that ship this job — the core CI
 * that `biffo init` emits and the sibling skeleton that `biffo sibling create`
 * emits — so dropping the flag from either one fails here instead of silently
 * re-coupling every scaffolded repo's CI to its contributors' open branches.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const WORKFLOWS = [
  join(repoRoot, '.github/workflows/ci.yml'),
  join(repoRoot, '_skeletons/sibling-template/.github/workflows/ci.yml'),
]

/** Every `gitleaks detect ...` command line in a workflow file. */
function gitleaksInvocations(workflowPath: string): string[] {
  return readFileSync(workflowPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('gitleaks detect'))
}

describe.each(WORKFLOWS)('Secret Scan scope — %s', (workflow) => {
  const invocations = gitleaksInvocations(workflow)

  it('runs both a git-history pass and a --no-git filesystem pass', () => {
    // The filesystem pass mirrors what a generated repo sees on its first CI
    // run, where the initial commit contains every template file. Losing it
    // would leave secrets in unchanged files unscanned.
    expect(invocations).toHaveLength(2)
    expect(invocations.filter((l) => l.includes('--no-git'))).toHaveLength(1)
  })

  it('scopes the git-history pass to commits reachable from HEAD', () => {
    const history = invocations.filter((l) => !l.includes('--no-git'))
    expect(history).toHaveLength(1)
    expect(history[0]).toContain('--log-opts="--full-history HEAD"')
  })

  it('keeps fetch-depth: 0 so the full reachable history is still walked', () => {
    // Reducing fetch-depth would also stop foreign refs from being scanned, but
    // at the cost of the commit-then-removed-within-a-branch detection this job
    // exists to provide. --log-opts fixes the scope without that trade.
    const job = readFileSync(workflow, 'utf8').split('security-secrets:')[1]
    expect(job).toContain('fetch-depth: 0')
  })

  it('still fails the build on a finding', () => {
    for (const line of invocations) expect(line).toContain('--exit-code=2')
  })
})
