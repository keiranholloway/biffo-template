import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * The second signal on `guard-candidates.ts`'s discovery+classification
 * mechanism, for class issue #1363: "a gate in this estate cannot report
 * green without either covering its whole input or naming what it skipped."
 *
 * ## Why this extends guard-candidates.ts rather than building separately
 *
 * #1519 already built the machinery this class needs a home on:
 * `discoverGuardCandidates` enumerates every guard-shaped file under
 * `cli/src/lib` from two independent signals (never a hand-maintained
 * list), and `GUARD_CANDIDATE_CLASSIFICATION` forces every candidate to be
 * explicitly resolved — `isGuard: true` with a reason, or `isGuard: false`
 * with one — before `guard-candidates.test.ts` lets the build pass. A
 * second question ("does it print its denominator when it passes?") on the
 * same enumerated set is the natural extension of that mechanism, not a new
 * one: building a parallel discovery pass here would be exactly the
 * drifting-second-copy defect this estate keeps re-finding (`_extract_detail`
 * written twice, `AGENTS.md` absent from eleven of seventeen repos, four
 * divergent `in-progress` label descriptions — see AGENTS.md's own framing).
 *
 * ## What "prints a denominator" means, mechanically
 *
 * A gate that sweeps N inputs and reports pass/fail over them must say what
 * N was — `checked 14 guard(s)`, `examined 0 candidate(s)`, `[coverage]
 * scanner: 9 path(s) reached`. `sourceDeclaresDenominatorPrint` detects this
 * STATICALLY, via the TypeScript AST (never a regex over source text, #956,
 * the same discipline `guard-candidates.ts` already holds itself to): a call
 * to a print-like function (`console.log`/`warn`/`error`/`info` or
 * `process.stdout`/`stderr.write`) whose argument is a template literal (or
 * `+`-concatenation) that BOTH contains denominator vocabulary in its
 * literal text AND interpolates at least one non-literal expression — i.e.
 * a runtime-computed value, not a hardcoded string. A template with no
 * interpolation, or one that interpolates only for reasons unrelated to a
 * count, is deliberately not enough: the point is a NUMBER stated at
 * runtime, not a string that merely uses the right words.
 *
 * ## What this cannot do, stated rather than silently narrowed
 *
 * The print does not have to live in the guard's own `.ts` file — several
 * real guards in this repo are pure functions whose caller prints the count
 * (`python-test-scope-scan.ts`'s own docstring says so explicitly: "the
 * coverage count this guard's own test prints is the check that the walk is
 * actually running"). So `guardPrintsDenominator` checks the guard's own
 * file AND its same-basename `.test.ts` pair. It does NOT search arbitrary
 * third-party callers (e.g. `template-owned-scope.test.ts` importing
 * `python-test-scope-scan.ts` — a different file, not this guard's pair) —
 * that would require a full reverse-import graph and is out of scope here;
 * `guard-wiring-sweep.test.ts` already builds that graph for reachability
 * and a future change could join the two. A guard whose only print lives in
 * an unrelated caller is therefore correctly reported as NOT detected here,
 * and must be tracked in the exemption baseline with that reason stated —
 * never silently passed.
 */

const DENOMINATOR_VOCABULARY =
  /\b(examined|checked|audited|scanned|covered|considered|classified|discovered|counted|denominator|found \d|reached|analysed|analyzed|processed|swept|walked|visited|verified|validated|inspected|assessed|evaluated|resolved|matched)\b/i

/** True if `text` — the concatenated LITERAL portions of a print call's
 * argument (never the interpolated values themselves) — reads as a
 * denominator-shaped phrase. */
function looksLikeDenominatorPhrase(text: string): boolean {
  return DENOMINATOR_VOCABULARY.test(text)
}

const PRINT_OBJECT_NAMES = new Set(['console'])
const PRINT_METHOD_NAMES = new Set(['log', 'warn', 'error', 'info'])

function isPrintCallee(expr: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expr)) return false
  const method = expr.name.text
  // console.log / console.warn / console.error / console.info
  if (ts.isIdentifier(expr.expression) && PRINT_OBJECT_NAMES.has(expr.expression.text)) {
    return PRINT_METHOD_NAMES.has(method)
  }
  // process.stdout.write / process.stderr.write
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === 'process' &&
    (expr.expression.name.text === 'stdout' || expr.expression.name.text === 'stderr') &&
    method === 'write'
  ) {
    return true
  }
  return false
}

/** Literal text + whether at least one non-literal part was interpolated,
 * for a template literal (`` `a ${b} c` ``) or a `+`-concatenation chain
 * (`'a ' + b + ' c'`). Returns `null` for anything else (a bare string, a
 * single identifier, a function call with no string shape at all). */
function literalPartsOf(expr: ts.Expression): { text: string; hasDynamicPart: boolean } | null {
  if (ts.isTemplateExpression(expr)) {
    const text = expr.head.text + expr.templateSpans.map((s) => s.literal.text).join(' ')
    return { text, hasDynamicPart: expr.templateSpans.length > 0 }
  }
  if (ts.isNoSubstitutionTemplateLiteral(expr) || ts.isStringLiteralLike(expr)) {
    return { text: expr.text, hasDynamicPart: false }
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalPartsOf(expr.left)
    const right = literalPartsOf(expr.right)
    const leftText = left?.text ?? ''
    const rightText = right?.text ?? ''
    const leftDynamic = left?.hasDynamicPart ?? !ts.isStringLiteralLike(expr.left)
    const rightDynamic = right?.hasDynamicPart ?? !ts.isStringLiteralLike(expr.right)
    return { text: `${leftText} ${rightText}`, hasDynamicPart: leftDynamic || rightDynamic }
  }
  return null
}

/** True for a call whose callee reads as report-string construction fed to
 * an array the caller will later join and print — `lines.push(...)` /
 * `out.push(...)`, the idiom `formatReductionReport` and its siblings use
 * (build a `lines: string[]`, `.push` each line, `.join('\n')` at the end).
 * Deliberately name-agnostic about the receiver (`lines`, `out`, `parts` all
 * appear in this repo) and keyed on the METHOD, `push`, which is specific
 * enough not to false-positive on unrelated array use. */
function isReportLinePush(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === 'push' &&
    ts.isIdentifier(expr.expression)
  )
}

/**
 * Does `source` (the text of a `.ts` file) construct a runtime-computed
 * denominator anywhere in its own reporting output? AST-based, per #956 —
 * never a regex over the raw source text; the vocabulary regex above runs
 * only over literal text already extracted from parsed template/
 * concatenation nodes, so it cannot be defeated by a denominator-shaped word
 * sitting in a comment or an unrelated string.
 *
 * Two shapes, because that is what this repo's guards actually use — see
 * the module docstring for the survey that found it:
 *
 *   1. A direct print call: `console.log`/`warn`/`error`/`info` or
 *      `process.stdout`/`stderr.write`, argument a dynamic template/
 *      concatenation.
 *   2. Report-STRING construction the guard itself performs, for a caller
 *      to print — `formatReductionReport`'s
 *      `` `shared-file reduction check: ${report.analysed.length} mapping(s)
 *      analysed, ...` `` is the real example this shape was added for. Two
 *      forms: a `return <dynamic template/concat>` (the `formatFindings`-
 *      style one-liner), or a `<lines>.push(<dynamic template/concat>)`
 *      (the multi-line report idiom). The guard doing the string-building is
 *      what states the denominator; the caller's `console.log(formatX(...))`
 *      is a trivial pass-through and forcing the search into command-layer
 *      wrappers this repo does not co-locate with the guard would miss the
 *      real work every time.
 */
export function sourceDeclaresDenominatorPrint(source: string, fileName = 'source.ts'): boolean {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  let found = false

  const matches = (parts: ReturnType<typeof literalPartsOf>): boolean =>
    parts !== null && parts.hasDynamicPart && looksLikeDenominatorPhrase(parts.text)

  const visit = (node: ts.Node): void => {
    if (found) return

    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (isPrintCallee(node.expression)) {
        for (const arg of node.arguments) {
          if (matches(literalPartsOf(arg))) {
            found = true
            return
          }
        }
        // Multi-arg shape: console.log('checked', n, 'item(s)') — first arg
        // is a denominator-shaped literal, and at least one later arg is not
        // a literal (i.e. a runtime value sitting beside the words).
        const first = node.arguments[0]
        if (first && ts.isStringLiteralLike(first) && looksLikeDenominatorPhrase(first.text)) {
          const hasDynamicArg = node.arguments
            .slice(1)
            .some((a) => !ts.isStringLiteralLike(a) && !ts.isNumericLiteral(a))
          if (hasDynamicArg) {
            found = true
            return
          }
        }
      } else if (isReportLinePush(node.expression)) {
        for (const arg of node.arguments) {
          if (matches(literalPartsOf(arg))) {
            found = true
            return
          }
        }
      }
    }

    if (ts.isReturnStatement(node) && node.expression && matches(literalPartsOf(node.expression))) {
      found = true
      return
    }

    node.forEachChild(visit)
  }

  visit(sourceFile)
  return found
}

/**
 * Whether guard `guardFile` (a basename under `dir`, as `discoverGuardFiles`
 * returns) prints a denominator when it passes — checked against its own
 * source AND, if present, its same-basename `.test.ts` pair. See the module
 * docstring for what this deliberately does not reach (a print in an
 * unrelated caller file).
 */
export function guardPrintsDenominator(dir: string, guardFile: string): boolean {
  const ownPath = join(dir, guardFile)
  const testPath = join(dir, guardFile.replace(/\.ts$/, '.test.ts'))

  const sources: string[] = []
  if (existsSync(ownPath)) sources.push(readFileSync(ownPath, 'utf8'))
  if (existsSync(testPath)) sources.push(readFileSync(testPath, 'utf8'))

  return sources.some((s) => sourceDeclaresDenominatorPrint(s))
}
