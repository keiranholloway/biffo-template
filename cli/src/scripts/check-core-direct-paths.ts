/**
 * CI entrypoint for the core-direct-paths guard (issue #1377): fail when a
 * frontend's core-direct call site (one bypassing its own BFF, prefixed with
 * a declared external base like `CORE_API_URL`) names a route prefix this
 * repo's own Core API does not register.
 *
 * ── What this DOES check by default ─────────────────────────────────────
 *
 * With no arguments, this audits `_skeletons/sibling-template/apps/frontend`
 * — the scaffold every new sibling starts from — against this repo's own
 * `services/api/src`. That is a real, self-contained assertion: the skeleton
 * should ship with zero core-direct call sites (a fresh scaffold has no BFF
 * bypasses baked in; see `auditSiblingCoreDirectPaths`'s own test suite,
 * which makes the identical self-check against `modules/plugins/_template`
 * for the adjacent EventBridge guard). It is template-owned, self-contained,
 * and safe to run on every PR to this repo.
 *
 * ── What this does NOT check ─────────────────────────────────────────────
 *
 * #1377's actual motivating case — `tabsii-intake`, 7 of 7 call sites
 * unmatched — lives entirely outside this repo: it needs a REAL sibling's
 * frontend source checked out alongside this repo's core. This repo's own CI
 * only ever checks out this repo, so it structurally cannot reach that data
 * without a cross-repo checkout naming a specific sibling and a token with
 * read access to it — neither of which exists yet, and setting either up
 * unilaterally from inside a guard-wiring change was judged out of scope
 * (see biffo-template#1413's PR body for the estate-wide follow-up this
 * implies).
 *
 * `--sibling`/`--frontend-src`/`--core-src` let this same entrypoint audit a
 * REAL sibling: `sh scripts/biffo.sh check core-direct-paths --sibling
 * tabsii-intake --frontend-src ~/code/tabsii-intake/apps/frontend/src
 * --core-src ~/code/biffo-template/services/api/src`. That is the shape an
 * estate-wide script (run locally, or from a future workflow with the right
 * checkout) would drive per sibling — this module is deliberately
 * directory-parametrised for exactly that reuse (see
 * `core-direct-paths-audit.ts`'s own module doc comment).
 */
import { join } from 'node:path'
import { execa } from 'execa'
import { auditSiblingCoreDirectPaths } from '../lib/core-direct-paths-audit.js'

export interface CoreDirectPathsCheckOptions {
  sibling?: string
  frontendSrc?: string
  coreSrc?: string
}

export async function runCoreDirectPathsCheck(
  opts: CoreDirectPathsCheckOptions = {},
): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  const sibling = opts.sibling ?? 'sibling-template (self-check)'
  const frontendSrcDir =
    opts.frontendSrc ?? join(root, '_skeletons', 'sibling-template', 'apps', 'frontend', 'src')
  const coreApiSrcDir = opts.coreSrc ?? join(root, 'services', 'api', 'src')

  const report = auditSiblingCoreDirectPaths({ sibling, frontendSrcDir, coreApiSrcDir })

  // Denominator first, unconditionally — a green run that never says how much
  // it looked at is indistinguishable from one that looked at nothing.
  console.log(
    `audited ${report.extractedCount} core-direct call site(s) across ${report.frontendFiles} ` +
      `frontend file(s) under ${frontendSrcDir}, against ${report.corePrefixCount} route ` +
      `prefix(es) from ${report.coreFiles} core file(s) under ${coreApiSrcDir}`,
  )

  if (!report.ok) {
    console.error(`✗ core-direct-paths guard (${sibling}): unmatched or unresolved call site(s)\n`)
    if (report.frontendBlind) {
      console.error(
        '  BLIND (frontend): raw source contains external-base interpolations but the ' +
          'extractor found none — the extractor broke, this is not evidence of a clean tree.',
      )
    }
    if (report.coreBlind) {
      console.error(
        '  BLIND (core): raw source contains APIRouter(...) call sites but no prefixes were ' +
          'extracted — the extractor broke, this is not evidence core registers nothing.',
      )
    }
    for (const p of report.unmatched) {
      console.error(
        `  UNMATCHED  ${p.file}:${p.line}  ${JSON.stringify(p.raw)} -> normalised ` +
          `${JSON.stringify(p.normalized)}, no core route prefix matches`,
      )
    }
    for (const p of report.unresolved) {
      console.error(
        `  UNRESOLVED ${p.file}:${p.line}  ${JSON.stringify(p.raw)} -> ${p.unresolvedReason}`,
      )
    }
    console.error('\nSee biffo-template#1377.')
    process.exit(1)
  }

  console.log(`✓ core-direct-paths guard: ${report.summary}`)
}
