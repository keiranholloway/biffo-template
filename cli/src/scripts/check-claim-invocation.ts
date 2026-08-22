/**
 * CI entrypoint for the claim-invocation parity guard: fail when the
 * `AGENTS.md` copies this repo distributes disagree about how to claim an
 * issue, or when any of them still documents an untokened `claim <issue>`.
 *
 * `--as <token>` shipped in #1279, reached the template's own `AGENTS.md`, and
 * reached **neither skeleton** — so it was documented in zero satellites while
 * working perfectly, and every session in the estate went on claiming
 * anonymously (#1562). Nothing failed, because nothing compared the copies.
 *
 * The copies are discovered rather than listed (repo root, plus every
 * `_skeletons/<name>/AGENTS.md`), and finding none is a failure rather than a
 * pass — a guard whose input set is empty reports success against the exact bug
 * it exists to catch (#695).
 */
import { execa } from '../lib/exec.js'
import {
  auditClaimInvocationParity,
  distributedAgentsDocs,
  formatParityViolations,
} from '../lib/claim-invocation-parity.js'

export async function runClaimInvocationCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
  const docs = distributedAgentsDocs(root)

  console.log(
    `audited ${docs.length} distributed AGENTS.md (${docs.map((d) => d.path).join(', ') || 'none'}) under ${root}`,
  )

  const violations = auditClaimInvocationParity(docs)
  if (violations.length > 0) {
    console.error('✗ Claim-invocation guard: the distributed AGENTS.md copies disagree\n')
    console.error(formatParityViolations(violations))
    console.error(
      '\nEvery copy must document the same invocation, and `--as <token>` is mandatory ' +
        '(#1562). Fix the skeletons too — they are what satellites receive.',
    )
    process.exit(1)
  }

  console.log(
    '✓ Claim-invocation guard: every distributed AGENTS.md documents the same, tokened, claim',
  )
}
