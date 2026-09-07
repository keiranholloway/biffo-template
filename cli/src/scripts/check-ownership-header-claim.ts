/**
 * CI entrypoint for the ownership-header-claim guard (#1911, split from
 * #1362's "a guard reads a different document from the one that acts"
 * class): fail when a file's own header comment claims `INSTANCE-OWNED`,
 * `template-owned`, `user-owned`, or `NOT a template file` and
 * `core-manifest.json`'s real longest-prefix-match answer
 * (`isTemplateOwned`, `core-manifest.ts`) disagrees.
 *
 * `scripts/verify-deployed.checks` lived this exact gap until a human
 * noticed by hand (#1706/#1707): its header said `INSTANCE-OWNED` while the
 * manifest disagreed, and nothing but a person reading both documents at
 * once could have caught it. See `ownership-header-claim-guard.ts`'s module
 * doc comment for the full discovery-heuristic reasoning and the corpus it
 * was checked against.
 *
 * Skipped, not failed, on a satellite repo (a plugin, a sibling app, the
 * design repo, a runner fleet) — none of those carry a `core-manifest.json`
 * at all, so there is nothing to compare a claim against. Runs identically
 * in the template and in an instance: both carry a real manifest, and an
 * instance's own copies of these swept directories can drift a header claim
 * out of step with the manifest exactly as the template's can.
 */
import { execa } from '../lib/exec.js'
import { classifyRepoOwnership } from '../lib/core-ownership-guard.js'
import { readCoreManifest } from '../lib/core-manifest.js'
import {
  checkOwnershipHeaderClaims,
  sweepOwnershipHeaderClaims,
} from '../lib/ownership-header-claim-guard.js'

export async function runOwnershipHeaderClaimCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  const ownership = classifyRepoOwnership(root)
  if (ownership === 'satellite') {
    console.log(
      '✓ ownership-header-claim guard: skipped — this repo carries no core-manifest.json, ' +
        'so there is no ownership authority to check a header claim against.',
    )
    return
  }

  const manifest = readCoreManifest(root)
  const hits = sweepOwnershipHeaderClaims(root)

  // Denominator first, unconditionally — same discipline as
  // check-orphan-ratchet.ts and check-instance-adoption.ts: a clean run that
  // never says how much it looked at is indistinguishable from one that
  // looked at nothing (#1363).
  console.log(
    `examined ${hits.length} file(s) carrying an ownership-style header claim under ` +
      'scripts/, .githooks/, .github/, services/, cli/, infra/',
  )

  // Read-back check, same shape as the codeql-suppression and pipe-trap
  // guards: refuse to report success over zero input. This repo's real tree
  // carries 140+ files matching the discovery patterns (#1911's own
  // measurement), so a sweep that finds none has broken — most likely
  // `git rev-parse --show-toplevel`/`git ls-files` failing in a way
  // `sweepOwnershipHeaderClaims` swallows into an empty result — not a repo
  // that genuinely stopped documenting ownership anywhere.
  if (hits.length === 0) {
    console.error(
      '✗ ownership-header-claim guard: swept zero files — refusing a false green rather than ' +
        'assuming every ownership-style header vanished.',
    )
    process.exit(1)
    return
  }

  const disagreements = checkOwnershipHeaderClaims(hits, manifest)

  if (disagreements.length > 0) {
    console.error(
      `✗ ownership-header-claim guard: ${disagreements.length} of ${hits.length} file(s) carry ` +
        'a header claim core-manifest.json disagrees with (#1911):\n',
    )
    for (const d of disagreements) {
      console.error(
        `  ${d.path}:${d.line}  header says "${d.matchedPhrase}" (${d.claim}-owned), but ` +
          `core-manifest.json says ${d.manifestSaysTemplateOwned ? 'template-owned' : 'user-owned'}`,
      )
    }
    console.error(
      '\nEither fix the header to match core-manifest.json, or fix core-manifest.json to ' +
        'match reality — never leave the two disagreeing.',
    )
    process.exit(1)
    return
  }

  console.log(
    `✓ ownership-header-claim guard: examined ${hits.length} file(s), all agree with ` +
      'core-manifest.json',
  )
}
