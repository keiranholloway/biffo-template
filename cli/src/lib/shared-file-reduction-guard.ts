import { readFileSync } from 'node:fs'
import ts from 'typescript'

/**
 * Refuse a shared-file sync that would DELETE content from the satellite it
 * is about to overwrite (#1577).
 *
 * ## The near-miss this exists for
 *
 * `shared-files.json` maps `biffo-plugin-ideation`'s `web/src/lib/auth.test.ts`
 * onto the plugin skeleton's copy through `filesIfPresent`. That mapping is a
 * one-way `cp`: `stage_repo` in `scripts/shared-sync.sh` writes the canonical
 * copy over whatever the satellite holds, and has never compared the two.
 * #1546 added the mapping **in the same commit that created the canonical
 * file**, without diffing the one repo that already held the path. The two
 * were disjoint:
 *
 *   - canonical (skeleton): 5 tests, all `getCurrentSession` / pool-race
 *     memoisation;
 *   - ideation's: 4 tests, all `getFreshIdToken`, including the regression
 *     guard for the stale-JWT bug (ideation #69/#70).
 *
 * The canonical copy was a strict SUBSET. A sync would have stripped four
 * assertions — one of them a live regression guard — from the repo with the
 * weakest CI coverage in the estate. Nothing in the pipeline would have said
 * a word: `diff_files` reports "differs", not "differs by deleting", and a
 * sync PR's diff reads as machine output, so deletions inside one look like
 * tidying. It was caught by a human reading the diff, and fixed by folding
 * upstream first (#1575) so the satellite received a superset of 9 tests.
 *
 * ## Which level of guard this is, and why
 *
 * #1577 proposed two:
 *
 *   1. **Registration time** — when a `files` / `filesIfPresent` mapping is
 *      ADDED, assert the canonical copy is a superset of every existing
 *      satellite copy of that path.
 *   2. **Sync time** — a sync that would REDUCE a satellite file fails rather
 *      than proceeding.
 *
 * This is **level 2**, and level 1 is not separately implementable here for
 * two reasons that are properties of the repo rather than preferences:
 *
 *   - **The satellite content is not in this repository.** A superset check
 *     needs the other side of the comparison, and every copy of it lives in
 *     fifteen other GitHub repos. The only place in this estate where both
 *     sides exist at once is `scripts/shared-sync.sh`, which has already
 *     fetched the satellite and checked it out — i.e. the sync. A
 *     registration-time check would have to grow its own fetch/auth/clone
 *     path, duplicating the one `shared-sync.sh` already owns, to answer the
 *     same question later and less reliably.
 *   - **`shared-files.json` is data, so a registration guard has to detect
 *     CHANGES to it** — a diff against a base ref. That check is silent on
 *     every commit that does not touch the manifest, which is exactly the
 *     posture that made this class invisible: it fires once, on the commit
 *     that adds a mapping, and never again. A mapping added safely and later
 *     made lossy by an upstream edit to the canonical file — a real and
 *     equally destructive shape — is outside it entirely.
 *
 * Level 2 is strictly stronger on both counts: it fires on EVERY sync, over
 * every mapping, at the moment of the overwrite, with both files in hand.
 * The incident is caught by it, and so is the shape level 1 cannot see.
 *
 * ## What "reduce" means here — and where it does NOT mean anything
 *
 * **This guard analyses TypeScript/JavaScript test files and nothing else.**
 * Say so plainly rather than implying estate-wide coverage: see
 * `classifyTarget`, and note that every caller is required to print the
 * unanalysable mappings alongside the analysed ones. A check that quietly
 * drops the inputs it cannot evaluate reports the remainder as the whole,
 * which is `protection-audit.sh`'s #1145 defect and the reason that rule is
 * written down.
 *
 * For a test file, "reduce" has a definition that is both precise and quiet:
 * the set of test titles the satellite declares must be a SUBSET of the set
 * the canonical copy declares. A title in the satellite with no counterpart
 * upstream is an assertion the sync is about to delete. Titles are read from
 * the TypeScript AST, never a regex over source text (#956), so a commented-
 * out `it(...)` cannot manufacture one and `it.each`/`it.only`/`test.skip`
 * are all found.
 *
 * A line-count or line-set rule was considered for arbitrary files and
 * deliberately rejected. Every legitimate sync of a script or a config
 * rewrites lines, so a line-set rule fires on nearly every honest round —
 * and a guard that fires on every PR is one people learn to bypass, which is
 * the argument `check-closing-keywords.mjs` already makes about its own path
 * list. A guard that is narrow and believed beats a broad one that is
 * routinely overridden.
 *
 * ## What this guard does NOT catch
 *
 * Stated here, in the code, because #1577 asks for it explicitly and because
 * an unstated limit is how a narrow guard gets mistaken for a broad one:
 *
 *   - **Any non-test file.** `AGENTS.md`, `scripts/*.sh`, `.githooks/*`,
 *     `auth.ts`, `api-client.ts` — a `filesIfPresent` overwrite can delete
 *     satellite-only content in every one of them and this guard will report
 *     the mapping as `not analysable` and pass it.
 *   - **Shell test files.** `scripts/routing-smoke-test.test.sh` is
 *     distributed by `files` and is a test file, but its cases are shell
 *     functions, not `it(...)` calls; no AST is parsed for it.
 *   - **Content lost INSIDE a test that survives by name.** Two files can
 *     declare the same titles while one has three `expect`s and the other
 *     one. Titles are the unit compared; assertions inside them are not.
 *   - **A test RENAMED upstream** reads as one title lost and one gained, so
 *     it fires. That is deliberate — a rename and a deletion are the same
 *     event to a reader of the satellite — but it means the escape hatch
 *     below is load-bearing, not decorative.
 *   - **Setup, helpers, mocks and imports.** A satellite's bespoke
 *     `vi.mock` factory can vanish without a finding as long as no title
 *     does.
 *   - **Deletion of the file outright**, which no list in
 *     `shared-files.json` can currently express, so there is nothing to
 *     guard.
 *
 * ## The escape hatch
 *
 * `shared-files.json`'s `acceptedReductions` maps a target path to
 * `{ "<test title>": "<why the loss is intended>" }`. #1577's requirement is
 * that the author must "fold in or explicitly declare the loss intended" —
 * that map is the declaration. Accepted titles are still counted and printed
 * as accepted; they do not disappear from the report, only from the failure.
 */

/** Call names whose first argument is a test title. `describe` is collected
 * for context in the report, and deliberately NOT compared: renaming a
 * `describe` while keeping every test under it deletes nothing, and
 * comparing fully-qualified names would turn that into a finding. */
const LEAF_TEST_CALLS = new Set(['it', 'test'])
const SUITE_CALLS = new Set(['describe', 'suite'])

const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/** Whether a mapping's target can be analysed at all, and if not, why —
 * required so callers can print the mappings this guard skipped rather than
 * reporting the remainder as the whole set (#1145's lesson). */
export type TargetClassification = { analysable: true } | { analysable: false; reason: string }

export function classifyTarget(target: string): TargetClassification {
  if (TEST_FILE_PATTERN.test(target)) return { analysable: true }
  return {
    analysable: false,
    reason: 'not a TypeScript/JavaScript test file — this guard compares test titles only',
  }
}

/**
 * The base identifier of a call's callee, unwrapping the member and template
 * forms test runners use: `it`, `it.only`, `it.skip`, `it.each([...])`,
 * `it.concurrent.only`, and the tagged-template `it.each\`…\``.
 */
function calleeBaseName(expression: ts.Expression): string | undefined {
  let node: ts.Node = expression
  for (;;) {
    if (ts.isPropertyAccessExpression(node)) {
      node = node.expression
      continue
    }
    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) {
      node = ts.isCallExpression(node) ? node.expression : node.tag
      continue
    }
    break
  }
  return ts.isIdentifier(node) ? node.text : undefined
}

/**
 * The title a test call declares, as a comparable string.
 *
 * A plain string literal or a substitution-free template is its own text. A
 * title built from an expression (a template with `${}`, a variable, a
 * `for` loop's binding) is recorded as its SOURCE TEXT — two copies of the
 * same file produce the same text, which is all a set comparison needs, and
 * it means a dynamic title is compared rather than silently dropped.
 */
function titleOf(call: ts.CallExpression): string | undefined {
  const [first] = call.arguments
  if (!first) return undefined
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text
  return first.getText()
}

export interface ExtractedTitles {
  /** `it` / `test` titles — the unit this guard compares. */
  tests: string[]
  /** `describe` / `suite` titles — reported for context, never compared. */
  suites: string[]
}

/**
 * Every test title declared in a TS/JS source, read from the AST.
 *
 * Never a regex over source text (#956): a commented-out `it('x')` or a
 * string mentioning `it(` must not manufacture a title, and a title inside a
 * helper function or a loop must still be found.
 */
export function extractTestTitles(source: string, filename = 'file.test.ts'): ExtractedTitles {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const tests: string[] = []
  const suites: string[] = []

  const visit = (node: ts.Node): void => {
    // `it.each([1, 2])('each %i', …)` is two nested calls, and the INNER one
    // also resolves to base name `it` — so a naive walk records `[1, 2]` as a
    // test title. Only the outermost call in a chain declares a test; a call
    // sitting in its parent's callee position is the curried half.
    const isCurriedHalf =
      node.parent !== undefined &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression === node
    if (ts.isCallExpression(node) && !isCurriedHalf) {
      const base = calleeBaseName(node.expression)
      if (base && (LEAF_TEST_CALLS.has(base) || SUITE_CALLS.has(base))) {
        const title = titleOf(node)
        if (title !== undefined) (LEAF_TEST_CALLS.has(base) ? tests : suites).push(title)
      }
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)

  return { tests, suites }
}

/** One mapping about to be written: the satellite path, the copy that is
 * there now, and the canonical copy that would replace it. */
export interface SyncPair {
  /** Path inside the satellite, as `shared-files.json` names it. */
  target: string
  /** Contents the satellite holds today — the bytes at risk. */
  existing: string
  /** Contents the sync would write over them. */
  incoming: string
}

export interface ReductionFinding {
  target: string
  /** Titles the satellite declares that the canonical copy does not — the
   * assertions this sync would delete. */
  lost: string[]
  /** Of those, the ones `acceptedReductions` declares intended. Reported,
   * not failed. */
  accepted: string[]
  /** Suites the lost titles sat under, for a message that reads. */
  suites: string[]
}

export interface SkippedMapping {
  target: string
  reason: string
}

export interface ReductionReport {
  /** Mappings whose titles were actually compared. */
  analysed: string[]
  /** Mappings this guard cannot evaluate, WITH the reason — printed by
   * every caller so the denominator is never silently shrunk. */
  skipped: SkippedMapping[]
  /** Reductions that are not declared intended. Non-empty means fail. */
  findings: ReductionFinding[]
  /** Reductions every one of whose lost titles is declared intended. */
  acceptedOnly: ReductionFinding[]
}

/** `shared-files.json`'s `acceptedReductions`: target path -> lost title ->
 * why the loss is intended. */
export type AcceptedReductions = Record<string, Record<string, string>>

/**
 * Compare each pair and report what the sync would delete.
 *
 * Pure: takes contents, not paths, so the sync can hand it exactly the two
 * blobs it is about to `cp` between rather than a second, independently
 * resolved read of them. That is the #1362 property stated as a design
 * choice — the guard must not derive its answer from a different document
 * than the actor acts on, or it can certify a copy it never saw.
 */
export function checkSharedFileReduction(
  pairs: SyncPair[],
  accepted: AcceptedReductions = {},
): ReductionReport {
  const report: ReductionReport = { analysed: [], skipped: [], findings: [], acceptedOnly: [] }

  for (const pair of pairs) {
    const classification = classifyTarget(pair.target)
    if (!classification.analysable) {
      report.skipped.push({ target: pair.target, reason: classification.reason })
      continue
    }
    report.analysed.push(pair.target)

    const before = extractTestTitles(pair.existing, pair.target)
    const after = extractTestTitles(pair.incoming, pair.target)
    const upstream = new Set(after.tests)
    const lost = before.tests.filter((title) => !upstream.has(title))
    if (lost.length === 0) continue

    const declared = accepted[pair.target] ?? {}
    const acceptedTitles = lost.filter((title) => title in declared)
    const finding: ReductionFinding = {
      target: pair.target,
      lost,
      accepted: acceptedTitles,
      suites: before.suites,
    }
    if (acceptedTitles.length === lost.length) report.acceptedOnly.push(finding)
    else report.findings.push(finding)
  }

  return report
}

/**
 * Human-readable report. Prints the skipped mappings first and always — a
 * caller reading only the failures would otherwise never learn how narrow
 * the analysed set is.
 */
export function formatReductionReport(report: ReductionReport): string {
  const lines: string[] = []
  lines.push(
    `shared-file reduction check: ${report.analysed.length} mapping(s) analysed, ` +
      `${report.skipped.length} not analysable`,
  )
  for (const skipped of report.skipped) {
    lines.push(`  - skipped ${skipped.target}: ${skipped.reason}`)
  }
  for (const accepted of report.acceptedOnly) {
    lines.push(
      `  - accepted loss in ${accepted.target}: ${accepted.accepted.length} title(s) declared ` +
        'intended in shared-files.json acceptedReductions',
    )
  }
  for (const finding of report.findings) {
    lines.push('')
    lines.push(`REFUSING TO OVERWRITE ${finding.target}`)
    lines.push(
      '  The canonical copy is not a superset: syncing it would delete these tests from the ' +
        'satellite.',
    )
    for (const title of finding.lost) {
      if (finding.accepted.includes(title)) continue
      lines.push(`    - ${title}`)
    }
    if (finding.suites.length > 0) {
      lines.push(`  (satellite suites: ${finding.suites.join(', ')})`)
    }
    lines.push(
      '  Fold the satellite-only tests into the canonical copy first (#1575 is the worked ' +
        'example), or declare the loss intended in shared-files.json acceptedReductions.',
    )
  }
  if (report.findings.length === 0 && report.acceptedOnly.length === 0) {
    lines.push('  no reduction found in the analysed mappings')
  }
  return lines.join('\n')
}

/** Read a pair off disk. Kept separate from the comparison so the comparison
 * stays pure and testable without a filesystem. */
export function readSyncPair(target: string, existingPath: string, incomingPath: string): SyncPair {
  return {
    target,
    existing: readFileSync(existingPath, 'utf8'),
    incoming: readFileSync(incomingPath, 'utf8'),
  }
}
