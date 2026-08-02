#!/usr/bin/env node
/**
 * Refuse `Closes #N` on a change whose behaviour only shows up once deployed.
 *
 * GitHub closes an issue the moment a PR body carrying a closing keyword is
 * merged. For most changes that is right and convenient. For a change whose
 * correctness cannot be observed until it is running somewhere, it closes the
 * issue at the exact moment the least is known about it — the suite is green,
 * nothing has been deployed, and nobody has looked.
 *
 * This is not a theoretical tidiness rule. It has cost this estate repeatedly:
 *
 *   - #275: portal navigation landing on the raw RSC payload was diagnosed,
 *     "fixed", shipped with a drift guard and closed. On a wrong cause. It
 *     survived a teardown and redeploy before a human clicked the link.
 *   - tabsii-platform#429/#436: two independent ORM/DDL column mismatches,
 *     each green in a lane that builds its schema from the same models it is
 *     checking, each found by a 500 on a live click-through.
 *   - tabsii-platform#511 (2026-08-02): `Closes #511` auto-closed it on merge,
 *     ten minutes before the deploy that proved anything. The evidence had to
 *     be added afterwards, as a comment on an already-closed issue.
 *
 * The rule this encodes is AGENTS.md's, verbatim: *do not close an issue you
 * have not seen fixed*. Use `Refs #N`, verify against reality, then close by
 * hand with what you saw.
 *
 * ## What counts as "only shows up once deployed"
 *
 * A path list, deliberately short. Every entry is somewhere this estate has
 * actually been bitten, not everywhere a bug could hide:
 *
 *   - `infra/`, `modules/cloud/` — Terraform. `terraform validate` says the
 *     HCL parses, never that the deployed resource behaves.
 *   - `.github/workflows/` — a workflow is only really run by running it.
 *   - `db/imports/` — applied by the importer at deploy time, against a real
 *     database, in an order no unit test reproduces.
 *   - `apps/portal/` — auth flows, client-side routing and CDN behaviour, the
 *     exact trio behind #275, #1104 and #1106.
 *
 * Application code, the CLI, and `services/api/src/` are all absent on
 * purpose. A pure function with a failing-first test is genuinely proven by
 * that test, and a guard that fires on every PR teaches people to bypass it.
 *
 * ## The escape hatch, and why it is a trailer
 *
 * A `Verified-on-deploy:` trailer in the PR body allows the closing keyword.
 * It exists for the honest case — a fix already confirmed on a running
 * environment, being landed after the fact — and it asks for the evidence in
 * the same breath, so the claim lands in the PR body where a reviewer sees it
 * rather than in someone's memory.
 */

/** Closing keywords GitHub actually acts on, per its own documentation. */
const CLOSING_KEYWORDS = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
]

export const VERIFIED_TRAILER = 'Verified-on-deploy:'

/** Paths whose behaviour a green suite does not evidence. See the module docstring. */
export const DEPLOY_ONLY_PREFIXES = [
  'infra/',
  'modules/cloud/',
  '.github/workflows/',
  'db/imports/',
  'apps/portal/',
]

/**
 * The issue references a body would close on merge.
 *
 * Matches `Closes #12`, `fixes owner/repo#12` and the `Closes: #12` colon
 * form. Deliberately ignores a keyword inside a fenced code block — a PR that
 * quotes a commit message in an example should not trip a gate.
 */
export function closingReferences(body) {
  if (!body) return []
  const withoutFences = body.replace(/```[\s\S]*?```/g, '')
  const pattern = new RegExp(
    `\\b(${CLOSING_KEYWORDS.join('|')})\\b:?\\s+((?:[\\w.-]+/[\\w.-]+)?#\\d+)`,
    'gi',
  )
  return [...withoutFences.matchAll(pattern)].map((m) => m[2])
}

/** Whether the author has claimed, in the body, to have verified this on a
 * deployed environment. Requires something after the colon: a bare trailer is
 * a box tick, not evidence. */
export function hasVerifiedTrailer(body) {
  if (!body) return false
  const line = body.split('\n').find((l) => l.trim().toLowerCase().startsWith(VERIFIED_TRAILER.toLowerCase()))
  if (line === undefined) return false
  return line.slice(line.indexOf(':') + 1).trim().length > 0
}

/** The changed paths that fall under a deploy-only prefix. */
export function deployOnlyPaths(changedFiles) {
  return changedFiles.filter((f) => DEPLOY_ONLY_PREFIXES.some((p) => f.startsWith(p)))
}

/**
 * The whole decision, pure so it is testable without a repo or a PR.
 *
 * Returns `{ ok }` on a pass, or `{ ok: false, references, paths }` naming
 * exactly what tripped it — a guard that says only "no" gets worked around.
 */
export function assess({ body, changedFiles }) {
  const references = closingReferences(body)
  if (references.length === 0) return { ok: true, reason: 'no-closing-keyword' }

  const paths = deployOnlyPaths(changedFiles)
  if (paths.length === 0) return { ok: true, reason: 'no-deploy-only-paths' }

  if (hasVerifiedTrailer(body)) return { ok: true, reason: 'verified-trailer' }

  return { ok: false, references, paths }
}

export function formatFailure({ references, paths }) {
  const shown = paths.slice(0, 10)
  const more = paths.length - shown.length
  return [
    `This PR would close ${references.join(', ')} on merge, and it changes`,
    'paths whose behaviour a green suite does not evidence:',
    '',
    ...shown.map((p) => `  - ${p}`),
    ...(more > 0 ? [`  …and ${more} more`] : []),
    '',
    'GitHub closes the issue the moment this merges — before it is deployed,',
    'and before anyone has seen it work. AGENTS.md: do not close an issue you',
    'have not seen fixed.',
    '',
    'Either:',
    '  - write `Refs #N` instead, deploy, verify by the route the reporter',
    '    used, then close the issue by hand with what you saw; or',
    `  - if you have ALREADY confirmed this on a running environment, add a`,
    `    \`${VERIFIED_TRAILER} <what you saw, and where>\` line to the PR body.`,
  ].join('\n')
}

// ── CLI ───────────────────────────────────────────────────────────────────
// Bare node, no install, matching practices-monotonic.mjs — so this runs in
// the Release Guards job without depending on the pnpm install step.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { execSync } = await import('node:child_process')

  const base = process.env.GITHUB_BASE_REF
  const body = process.env.PR_BODY ?? ''

  if (!base) {
    console.log('✓ closing-keyword guard: skipped — no GITHUB_BASE_REF (not a pull request).')
    process.exit(0)
  }

  let changedFiles = []
  try {
    changedFiles = execSync(`git diff --name-only origin/${base}...HEAD`, { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } catch (err) {
    // A guard that cannot see its input must say so rather than passing. The
    // estate's most repeated defect is a zero that means "could not look".
    console.error(`✘ closing-keyword guard: could not diff against origin/${base}.`)
    console.error(String(err?.stderr ?? err?.message ?? err))
    process.exit(1)
  }

  const result = assess({ body, changedFiles })
  if (result.ok) {
    console.log(`✓ closing-keyword guard: ${result.reason}.`)
    process.exit(0)
  }

  console.error(formatFailure(result))
  process.exit(1)
}
