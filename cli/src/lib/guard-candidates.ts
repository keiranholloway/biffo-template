import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * Broadened guard discovery for class issue #1519.
 *
 * ## The gap this closes
 *
 * `discoverGuardFiles` (`guard-wiring-sweep.test.ts`, #1413) and, downstream
 * of it, `guard-authority-inventory.ts` (#1362) both used to enumerate guards
 * with a single filename regex: `/-(audit|guard)\.ts$/`. That regex IS the
 * denominator every sweep built on it reports over, and it was never printed
 * — so "N guards, all wired" and "N guards, all classified" were both true
 * statements about a set the regex had already shrunk, silently, to whatever
 * happened to match `*-audit.ts` or `*-guard.ts`.
 *
 * `core-upgrade-target-fidelity.ts` is the proof this was not academic: it
 * exports `assertTargetFidelity` and behaves exactly like every other guard
 * in this directory, but is named `*-fidelity.ts` and so the regex never
 * found it. It had to be added to `guard-authority-inventory.ts` BY HAND —
 * and it turned out to carry two live instances of the exact #1362 defect
 * the inventory exists to catch (see that file's own docstring). The
 * enumeration built to make sure no guard goes uncounted did not count the
 * guard that was most broken.
 *
 * ## Why a wider regex alone is not the fix
 *
 * Widening `/-(audit|guard)\.ts$/` to also match `-fidelity.ts` or
 * `-check.ts` only moves the boundary one filename further out — the next
 * guard named something else is exactly as invisible as this one was. The
 * fix has to stop trusting a naming convention as the ONLY signal and force
 * an explicit answer for anything that behaves like a guard regardless of
 * what it is called.
 *
 * ## Two-signal discovery, then mandatory classification
 *
 * `discoverGuardCandidates` unions two independent signals, neither trusted
 * alone:
 *
 *   1. The naming convention this repo already uses — `*-audit.ts` /
 *      `*-guard.ts` — kept because it is real signal, not because it is
 *      sufficient.
 *   2. Every file under the directory that EXPORTS a function whose name
 *      reads as a guard verb — `assert*`, `verify*`, `check*`, `audit*` —
 *      read from the TypeScript AST (never a regex over source text, #956),
 *      so a renamed export is still found and a comment merely mentioning
 *      one of these words is not.
 *
 * That is still only a CANDIDATE list. `GUARD_CANDIDATE_CLASSIFICATION`
 * below is where every candidate is explicitly resolved to `isGuard: true`
 * (feeds the #1413 wiring sweep and the #1362 authority inventory) or
 * `isGuard: false` with a written reason — a candidate with neither is what
 * `guard-candidates.test.ts` fails the build on. That is the actual fix:
 * not a wider net, but a net that cannot let anything through uncounted.
 *
 * `discoverGuardFiles` — the name both consuming sweeps already imported —
 * is now the `isGuard: true` subset of `discoverGuardCandidates`, so #1413
 * and #1362 pick up the broadened, classified set automatically.
 */

const NAME_SUFFIX_PATTERN = /-(audit|guard)\.ts$/
const EXPORT_PREFIX_PATTERN = /^(assert|verify|check|audit)[A-Z]/

/** Every top-level EXPORTED function name in a `.ts` file — a `function`
 * declaration or a `const` bound to an arrow/function expression — read via
 * the TypeScript AST rather than a regex over source text (#956), so a
 * comment mentioning "check" or "assert" cannot manufacture a false
 * candidate and a renamed export is still found. */
function exportedFunctionNames(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const names: string[] = []

  sourceFile.forEachChild((node) => {
    const isExported = (n: ts.Node): boolean =>
      ts.canHaveModifiers(n) &&
      (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

    if (ts.isFunctionDeclaration(node) && node.name && isExported(node)) {
      names.push(node.name.text)
      return
    }
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          names.push(decl.name.text)
        }
      }
    }
  })

  return names
}

/** Every candidate guard file directly under `dir`, discovered from the
 * filesystem and the real exported names — never a hand-maintained list.
 * `.test.ts` always fails both signals, so a guard's own test file can never
 * be mistaken for the guard. */
export function discoverGuardCandidates(dir: string): string[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  const candidates = new Set<string>()

  for (const f of files) {
    if (NAME_SUFFIX_PATTERN.test(f)) {
      candidates.add(f)
      continue
    }
    const exported = exportedFunctionNames(join(dir, f))
    if (exported.some((name) => EXPORT_PREFIX_PATTERN.test(name))) {
      candidates.add(f)
    }
  }

  return [...candidates].sort()
}

export interface GuardCandidateVerdict {
  isGuard: boolean
  /** Required either way — why this candidate IS a guard (feeds the #1413
   * wiring sweep and #1362 authority inventory), or why it is NOT one
   * despite matching one of the two discovery signals. */
  reason: string
}

/**
 * Every candidate `discoverGuardCandidates` has ever found under
 * `cli/src/lib`, classified. `guard-candidates.test.ts` fails the build on
 * any candidate with no entry here — that is the actual acceptance criterion
 * from #1519: a new guard-shaped file cannot merge silently outside the set,
 * whichever of the two discovery signals it trips.
 *
 * The 15 files matching the pre-#1519 `/-(audit|guard)\.ts$/` convention are
 * carried forward as `isGuard: true` on that convention alone — they were
 * already individually classified for the #1362 question in
 * `guard-authority-inventory.ts`, and re-litigating "is a `*-guard.ts` file
 * a guard" here would be exactly the "3 guards swept when there are 30"
 * failure the estate has already named. The interesting decisions are the 8
 * candidates the export-name signal newly admits — five of them are the
 * files #1518's sweep spotted and left unclassified (build-freshness.ts,
 * doctor.ts, sibling-identity-check.ts, plugin-allowlist-convention.ts,
 * workflow-run-commands.ts), plus core-upgrade-target-fidelity.ts (already
 * hand-added to the #1362 inventory, now discovered natively) and two the
 * broadened signal surfaces for the first time (core-upgrade.ts,
 * interactive.ts) — answered below rather than deferred, per the issue's own
 * "whether any of them is a guard is exactly the question the enumeration is
 * meant to force."
 */
export const GUARD_CANDIDATE_CLASSIFICATION: Record<string, GuardCandidateVerdict> = {
  // ── Pre-#1519 naming-convention guards — carried forward unchanged ──────
  'adr-numbering-guard.ts': { isGuard: true, reason: 'matches the *-guard.ts convention' },
  'branch-protection-audit.ts': { isGuard: true, reason: 'matches the *-audit.ts convention' },
  'codeql-suppression-guard.ts': { isGuard: true, reason: 'matches the *-guard.ts convention' },
  'cognito-invite-template-guard.ts': {
    isGuard: true,
    reason: 'matches the *-guard.ts convention',
  },
  'core-direct-paths-audit.ts': { isGuard: true, reason: 'matches the *-audit.ts convention' },
  'core-ownership-guard.ts': { isGuard: true, reason: 'matches the *-guard.ts convention' },
  'eventbridge-log-permission-guard.ts': {
    isGuard: true,
    reason: 'matches the *-guard.ts convention',
  },
  'lambda-output-guard.ts': { isGuard: true, reason: 'matches the *-guard.ts convention' },
  'pipe-trap-guard.ts': { isGuard: true, reason: 'matches the *-guard.ts convention' },
  'plugin-collision-guard.ts': { isGuard: true, reason: 'matches the *-guard.ts convention' },
  'plugin-terraform-guard.ts': { isGuard: true, reason: 'matches the *-guard.ts convention' },
  'plugin-tool-supply-audit.ts': { isGuard: true, reason: 'matches the *-audit.ts convention' },
  'release-subject-guard.ts': { isGuard: true, reason: 'matches the *-guard.ts convention' },
  'skeleton-drift-guard.ts': { isGuard: true, reason: 'matches the *-guard.ts convention' },
  'terraform-input-guard.ts': { isGuard: true, reason: 'matches the *-guard.ts convention' },

  // ── Newly admitted by the export-name signal (#1519) ─────────────────────
  'build-freshness.ts': {
    isGuard: true,
    reason:
      'exports assertBuildIsFresh/checkBuildFreshness (issue #190): refuses to scaffold from a ' +
      'stale cli/dist. One of the five #1518 spotted and left unclassified.',
  },
  'core-upgrade-target-fidelity.ts': {
    isGuard: true,
    reason:
      'exports assertTargetFidelity (#1399) — the motivating file for #1519: it was hand-added ' +
      'to guard-authority-inventory.ts because the old regex never found it, and is now ' +
      'discovered natively.',
  },
  'doctor.ts': {
    isGuard: true,
    reason:
      'exports five checkX functions backing `biffo doctor` (#797) — repo-state checks including ' +
      'two real document/actor comparisons (local vs remote core version, fossil vs ' +
      'biffo.core.json). One of the five #1518 spotted and left unclassified.',
  },
  'plugin-allowlist-convention.ts': {
    isGuard: true,
    reason:
      'exports checkAllowlistConvention (#266): symbolically composes the IAM role name the ' +
      'naming modules build and compares it to the allowlist glob. One of the five #1518 ' +
      'spotted and left unclassified.',
  },
  'plugin-staleness.ts': {
    isGuard: true,
    reason:
      'exports checkPluginStaleness (#1547): a genuine document/actor comparison — a vendored ' +
      "services/<name>/'s recorded provenance (the document, plugin-provenance.ts) against the " +
      "plugin repo's live default-branch HEAD (the actor) — same shape as doctor.ts's document/" +
      'actor checks. Reachable from two commands/ entrypoints: `plugin-staleness.ts` (a real ' +
      'gate, `biffo plugin staleness`, with the estate 0/1/2 exit contract) and `check.ts` ' +
      "(`biffo check plugin-staleness`, deliberately advisory-only — see check.test.ts's " +
      'auditOnly list). Advisory at ONE call site does not make the module itself not a guard; ' +
      'the same distinction already applies to branch-protection-audit.ts.',
  },
  'sibling-identity-check.ts': {
    isGuard: true,
    reason:
      "exports checkSiblingIdentity (#400): compares a core's published identity document and " +
      "every sibling's baked-in Cognito pool id against the live pool. One of the five #1518 " +
      'spotted and left unclassified.',
  },
  'workflow-run-commands.ts': {
    isGuard: false,
    reason:
      'exports assertInvokes/assertRunsCommand, but both are test-authoring helpers used FROM ' +
      "other guards' own *.test.ts files to assert CI still invokes them (mirrors " +
      "workflow-run-commands.ts's own docstring on why toContain() is the wrong assertion) — " +
      'nothing outside a *.test.ts file imports this module. It never itself runs as a CI step ' +
      'against the repo, the same reason test-utils/tmp.ts is not a guard despite living beside ' +
      'guards. Confirmed by import search: only workflow-run-commands.test.ts and check.test.ts ' +
      'reference it.',
  },
  'core-upgrade.ts': {
    isGuard: false,
    reason:
      'exports checkOrphanRatchet, but that is one small internal comparator inside the core ' +
      "upgrade PLANNER — this file is the ACTOR several other guards' entries in " +
      "guard-authority-inventory.ts read about (e.g. core-ownership-guard's classify()), not a " +
      'standalone guard module with its own wiring. It is wired into the `core upgrade` command ' +
      'as a whole; splitting checkOrphanRatchet into its own guard file is out of scope for #1519.',
  },
  'interactive.ts': {
    isGuard: false,
    reason:
      'exports assertInteractive (#274), but it is a RUNTIME input-validation assertion — it ' +
      'converts a would-be interactive prompt into a hard error when --non-interactive is set. ' +
      "That is not a CI-time audit of the repo's own state, which is what #1362/#1413's " +
      '"guard" means throughout this inventory: there is no document/actor pair here, and no ' +
      'wiring question either — every command already calls it directly.',
  },
}

/** The `isGuard: true` subset of `discoverGuardCandidates(dir)` — what
 * #1413's wiring sweep and #1362's authority inventory each enumerate over.
 * A candidate with no classification entry is treated as NOT a guard here
 * (fail-closed for this function), but `guard-candidates.test.ts` fails the
 * build on it separately and loudly — this function silently under-counting
 * an unclassified candidate would defeat the point, so nothing should ever
 * reach this function unclassified in a passing build. */
export function discoverGuardFiles(dir: string): string[] {
  return discoverGuardCandidates(dir).filter(
    (f) => GUARD_CANDIDATE_CLASSIFICATION[f]?.isGuard === true,
  )
}
