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
 * `--sibling`/`--frontend-src`/`--estate` let this same entrypoint audit a
 * REAL sibling against the core THAT ACTUALLY SERVES IT: `sh scripts/biffo.sh
 * check core-direct-paths --sibling tabsii-intake --frontend-src
 * ~/code/tabsii-intake/apps/frontend/src --estate ~/code`. `--estate` points
 * at the directory holding every cloned repo; the sibling's own
 * `biffo.sibling.json` (`<estate>/<sibling>/biffo.sibling.json`) names its
 * `core_project`, and THAT instance's `services/api/src` is resolved as the
 * core to check against — never biffo-template's own, which is a different
 * app that does not serve the sibling at all (see
 * `resolveSiblingCoreSrc`'s doc comment in `core-direct-paths-audit.ts` for
 * the false-positive run this replaced: comparing every sibling against
 * biffo-template's own core, on `dev`, produced nine findings, one on every
 * `/api/v1/public/*` call site, that all vanished once each sibling was
 * checked against ITS OWN instance instead).
 *
 * `--core-src` remains as a direct override for ad-hoc/local use (it always
 * wins over `--estate` resolution) — the shape a future estate-wide
 * co-checkout script would drive per sibling either way, since this module is
 * deliberately directory-parametrised for exactly that reuse (see
 * `core-direct-paths-audit.ts`'s own module doc comment).
 */
import { join } from 'node:path'
import { execa } from '../lib/exec.js'
import {
  auditSiblingCoreDirectPaths,
  resolveSiblingCoreSrc,
} from '../lib/core-direct-paths-audit.js'

export interface CoreDirectPathsCheckOptions {
  sibling?: string
  frontendSrc?: string
  coreSrc?: string
  estate?: string
}

export async function runCoreDirectPathsCheck(
  opts: CoreDirectPathsCheckOptions = {},
): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  const sibling = opts.sibling ?? 'sibling-template (self-check)'
  const frontendSrcDir =
    opts.frontendSrc ?? join(root, '_skeletons', 'sibling-template', 'apps', 'frontend', 'src')

  // Resolution order: an explicit `--core-src` always wins (ad-hoc/local
  // override); otherwise, given a real `--sibling` and an `--estate`, resolve
  // the sibling's OWN core from its `biffo.sibling.json` -- fails loud rather
  // than falling back to this repo's core, which is exactly the bug being
  // fixed here. With neither, default to this repo's own core (the
  // self-check shape ci.yml runs, auditing the sibling skeleton against
  // biffo-template itself -- correct there, because the skeleton has no
  // instance to resolve).
  let coreApiSrcDir: string
  let coreProject: string | null = null
  if (opts.coreSrc) {
    coreApiSrcDir = opts.coreSrc
  } else if (opts.sibling && opts.estate) {
    let resolution: ReturnType<typeof resolveSiblingCoreSrc>
    try {
      resolution = resolveSiblingCoreSrc({ estateDir: opts.estate, sibling: opts.sibling })
    } catch (err) {
      console.error(`✗ core-direct-paths guard (${sibling}): ${(err as Error).message}`)
      process.exit(1)
    }
    coreApiSrcDir = resolution.coreApiSrcDir
    coreProject = resolution.coreProject
  } else {
    coreApiSrcDir = join(root, 'services', 'api', 'src')
  }

  const report = auditSiblingCoreDirectPaths({ sibling, frontendSrcDir, coreApiSrcDir })

  // Denominator first, unconditionally — a green run that never says how much
  // it looked at is indistinguishable from one that looked at nothing. The
  // resolved core project (when there is one) is printed IN this line so a
  // wrong-core comparison is visible without anyone reproducing it by hand
  // (#1377's second finding was exactly this, invisible until it was printed).
  console.log(
    `audited ${report.extractedCount} core-direct call site(s) across ${report.frontendFiles} ` +
      `frontend file(s) under ${frontendSrcDir}, against ${report.corePrefixCount} route ` +
      `prefix(es) from ${report.coreFiles} core file(s) under ${coreApiSrcDir}` +
      (coreProject ? ` (core project: ${coreProject})` : ''),
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
