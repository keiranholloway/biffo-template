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

/**
 * The filesystem pass walks the working DIRECTORY, not the index, so it reads
 * files git never sees.
 *
 * `.terraform/` is gitignored in every Biffo repo but a real `terraform.tfstate`
 * lives there once anyone runs `terraform init`/`apply`, carrying the real AWS
 * account id — which `biffo-aws-account-id` (`\b\d{12}\b`, broad again as of
 * #1628, with a rule-level allowlist excluding only a COMPLETE UUID shape —
 * see the test below) still matches correctly.
 * In CI that is invisible (a fresh checkout has no `.terraform/`); on a
 * workstation it failed `verify.sh` every run, for a file the developer is not
 * pushing and cannot remove.
 *
 * A gate that fails on something unfixable and unrelated to the change is how
 * `BIFFO_SKIP_VERIFY` gets set, and its usage rate is the H4 counter-metric
 * pre-registered as refuting the shift-left hypothesis. Surfaced the day
 * gitleaks was first installed locally across the estate; this template had
 * escaped it only because nobody had applied Terraform from this checkout.
 *
 * Asserted on the config's SHAPE rather than by running gitleaks: the JS test
 * job does not install it (only the Secret Scan job does), so a behavioural
 * assertion here would pass or fail depending on the machine — the exact trap
 * `verify-no-ci.test.ts` already documents.
 */
describe('gitleaks filesystem pass ignores gitignored local state', () => {
  const config = readFileSync(join(repoRoot, '.gitleaks.toml'), 'utf8')

  it('allowlists .terraform/', () => {
    expect(config).toContain('".terraform/"')
  })

  it('keeps the account-id rule itself intact', () => {
    // The allowlist narrows WHERE the rule looks. If it ever narrows WHAT it
    // matches, this is a suppression rather than a scope correction — the
    // distinction AGENTS.md §7 turns on.
    //
    // Two attempts at narrowing the REGEX itself both failed for the same
    // underlying reason (see .gitleaks.toml's comment and AGENTS.md §7 for
    // the full history): #893's blanket hyphen exclusion silently dropped
    // `my-app-artifacts-<id>`/`deploy-role-<id>`; #1628's word-level hex
    // heuristic (`(?:^|[^0-9A-Fa-f-]|[0-9A-Za-z]*[g-zG-Z][0-9A-Za-z]*-)(\d{12})\b`)
    // silently dropped any all-numeric prefix (`backup-2024-<id>`) or word
    // spelled only in a-f (`facade-<id>`), because the hex character class
    // includes all ten digits — there is no way to tell a UUID segment from
    // a date by looking at the word alone.
    //
    // The rule is now broad again (`\b\d{12}\b`) and the EXCLUSION lives
    // entirely in the allowlist, matching a COMPLETE UUID shape instead of
    // heuristic context around a hyphen — an exact condition rather than a
    // porous one. `regexTarget = "line"` is load-bearing: the reported
    // secret is only the 12-digit run, never the surrounding hyphens, so the
    // UUID allowlist regex has to be tested against the whole line to ever
    // match anything (verified against the real gitleaks 8.30.1 binary —
    // see cli/src/lib/gitleaks-uuid-account-id.test.ts, which proves the
    // broad rule still catches a genuine account id in every realistic
    // shape, including the two hyphenated-resource-name and three
    // hex-word-prefix cases the previous two regex attempts each missed,
    // while still exempting a UUID tail).
    expect(config).toContain("regex = '''\\b\\d{12}\\b'''")
    expect(config).toContain('regexTarget = "line"')
    expect(config).toContain(
      '"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"',
    )
  })

  it('allowlists no account id beyond the three with a written justification', () => {
    // Adding a literal 12-digit value to the allowlist is how a real finding
    // gets made to pass, which §7 forbids outright. Pinning the count means a
    // fourth cannot arrive without this test failing and someone reading why.
    //
    // The three are: two canonical placeholders used by fixtures, and fck-nat's
    // PUBLIC vendor account id — an `aws_ami` data source filters by `owners`,
    // so the publisher's id must appear literally. That one is published in
    // fck-nat's own docs and is identical in every deployment worldwide; it is
    // a bare-heuristic carve-out, not a secret.
    //
    // Written first as "exactly two" on the assumption that placeholders were
    // all there could be. The third was already there, correctly, with its
    // reasoning in the config — a reminder to read the file before asserting
    // what it ought to contain. The UUID allowlist entry added in #1628 is
    // NOT a fourth literal account id — it is a shape pattern, not a value —
    // so it is deliberately excluded from this count by the regex below,
    // which only matches a bare quoted 12-digit run.
    expect(config).toContain('"123456789012"')
    expect(config).toContain('"999999999999"')
    expect(config).toContain('"568608671756"')
    expect(config.match(/"\d{12}"/g)).toHaveLength(3)
  })
})
