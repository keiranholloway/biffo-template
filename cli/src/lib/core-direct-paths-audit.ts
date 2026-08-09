/**
 * Does a sibling's core-direct API call site actually exist on core? (#1377)
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * `_skeletons/sibling-template/services/api/tests/test_frontend_bff_paths.py`
 * (#1330/#1339) asserts every `/api/v1/...` literal a sibling's frontend calls
 * exists as a route on that sibling's OWN BFF. It deliberately EXCLUDES any
 * path prefixed with a declared external base identifier
 * (`EXTERNAL_BASE_IDENTIFIERS = frozenset({"CORE_API_URL"})`), because those
 * calls skip the BFF and go straight to core — correct for that guard, since
 * core is a different app entirely.
 *
 * Nobody asserts the excluded half. For `tabsii-intake`, measured 2026-08-09
 * against `origin/dev` of both `tabsii-intake` and `tabsii-platform`, that is
 * **7 of 7** of its extracted call sites (its BFF registers one router,
 * `whoami`, the frontend never calls) — the entire public-facing intake
 * surface (`demo-requests`, `disclosures`, `discovery-days`, `leads/{slug}`,
 * `marketplace`, `signatures`, `unsubscribe`) is unguarded end to end.
 *
 * ── Why this needs its own extractor, not a copy of #1330's ────────────────
 *
 * #1330's guard reads its OWN app in-process (`app.openapi()`), because the
 * frontend and the BFF it is checking live in the same repo and the same test
 * run. A sibling's frontend and CORE's routes never do: core is a separate
 * repository, checked out (or not) independently. This module is deliberately
 * **directory-parametrised** rather than importing anything live, so the same
 * two functions work whether the caller points them at local worktrees of two
 * different repos (the shape used here, and by `--estate`-style audits
 * elsewhere in this repo — see `scripts/protection-audit.sh`) or, later, at
 * something core's own CI checks out for itself (issue #1377's option 3,
 * explicitly out of scope for this pass — see its "Related" section).
 *
 * Both halves are read from their AUTHORITATIVE SOURCE each run, never a
 * committed fixture: `extractCoreDirectPaths` reads a sibling's frontend
 * source directly, and `extractCoreRoutePrefixes` reads core's own Python
 * router declarations directly. Neither is a hand-maintained second list —
 * that is the `_extract_detail` mistake this whole class of guard exists to
 * avoid (#1107/#1108, and the class issue #1364).
 *
 * ── What "exists on core" means here ────────────────────────────────────────
 *
 * This is a coarser check than #1330's: it matches at the ROUTER-PREFIX
 * level, not the full route-table level. That is not a shortcut taken for
 * convenience — it is the same granularity the call sites themselves are at.
 * `tabsii-intake`'s frontend never spells out a full endpoint path as one
 * literal; each file declares a `BASE` (or inlines the equivalent) as
 * `` `${CORE_API_URL}/api/v1/public/disclosures` `` and only THAT literal
 * starts with the declared external identifier — later uses
 * (`` `${BASE}/${token}` ``) reference the local variable, not
 * `CORE_API_URL`, and are invisible to a leading-interpolation extractor by
 * construction (true of #1330's extractor too, ported here rather than fixed
 * here — out of this issue's scope, and not a file this pass may touch,
 * `services/api/tests/**`). So the unit both halves agree on is the ROUTER
 * BASE: does the prefix a sibling's `BASE` constant names correspond to an
 * `APIRouter(prefix=...)` core actually registers under `/api/v1`? That is
 * exactly the question #218/#231 (the motivating incidents for #1330) asked
 * about a BFF route, one hop further out.
 *
 * `pathMatchesAnyCorePrefix` matches on a `/`-aligned boundary
 * (`normalized === full || normalized.startsWith(full + '/')`), so a longer
 * call site built directly off `CORE_API_URL` (e.g. the `public/leads`
 * inline call, which embeds the trailing `{brandSlug}` segment in the SAME
 * literal — see the module's own worked example below) still matches its
 * router's prefix without requiring an exact string match.
 *
 * ── Unresolvable input FAILS, it never silently passes (#1363, #1374) ──────
 *
 * A check that drops what it cannot evaluate shrinks its own denominator and
 * reports the remainder as the whole (AGENTS.md §2's `staging`-branch case is
 * the standing example). Two independent backstops enforce the opposite here:
 *
 * 1. **Per-call-site**: a literal built with string concatenation, or one
 *    whose backtick-scanning suggests a truncated nested template literal,
 *    is recorded with `normalized: null` and a reason — `unresolved`, never
 *    silently skipped. `auditSiblingCoreDirectPaths` fails the audit on ANY
 *    unresolved entry.
 * 2. **Whole-file blindness**: #1374 happened to the sibling half of this
 *    exact seam — a two-pass comment stripper let a `/*` inside a `//`
 *    comment's PROSE open a phantom block comment that ate ~180 lines of
 *    `tabsii-geo`'s `MapView.tsx`, including both of that file's real call
 *    sites, and the guard reported "0 found, 0 unmatched" and passed. This
 *    module's comment stripper is a single alternation for exactly that
 *    reason (see `stripComments`), and `auditFrontendExtraction` additionally
 *    counts every literal `${CORE_API_URL}`-shaped occurrence in the RAW,
 *    unstripped text and compares it to what the extractor actually found —
 *    if the raw count is positive and the extracted count is zero, that is
 *    blindness, not an honest clean, and `auditSiblingCoreDirectPaths` fails
 *    on it (`frontendBlind`). The same backstop exists on the core side
 *    (`coreBlind`): a raw count of `APIRouter(` calls with no prefixes
 *    extracted at all means the extractor broke, not that core registers
 *    nothing.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Interpolated identifiers that mean "this call goes to core directly,
 * skipping this sibling's own BFF" — kept in sync with #1330's guard by
 * naming convention, not by import (that guard lives in
 * `services/api/tests/**`, out of this pass's territory; see the module
 * docstring). Adding a name here is a deliberate statement that the
 * identifier denotes core's origin. */
export const EXTERNAL_BASE_IDENTIFIERS: readonly string[] = ['CORE_API_URL']

/** The version prefix every router core registers is mounted under —
 * verified against `tabsii-platform`'s `services/api/src/api/main.py`
 * (origin/dev, 2026-08-09): all 24 `app.include_router(...)` calls pass
 * `prefix="/api/v1"`, with no exception. */
export const API_ROUTE_PREFIX = '/api/v1'

const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx']
const LEADING_INTERPOLATION = /^\$\{\s*([A-Za-z_$][\w$]*)\s*\}/

export interface ExtractedCoreDirectPath {
  file: string
  line: number
  raw: string
  /** Comparable path with every dynamic segment collapsed to `{param}`, or
   * `null` when unresolvable — see `unresolvedReason`, always set exactly
   * when this is not. */
  normalized: string | null
  unresolvedReason: string | null
  /** Which declared identifier (`EXTERNAL_BASE_IDENTIFIERS`) this call site
   * was prefixed with. */
  externalBase: string
}

export interface CoreDirectExtractionResult {
  files: string[]
  extracted: ExtractedCoreDirectPath[]
  /** Literal `${IDENT}` occurrences counted directly on the RAW file text,
   * before any comment-stripping — the blindness backstop's other half. */
  rawTotal: number
}

export interface CoreRoutePrefixExtraction {
  prefixes: string[]
  /** Every `APIRouter(` call site seen, whether or not it declared a
   * `prefix=` — the blindness backstop's raw signal. */
  rawApiRouterCount: number
}

export interface CoreRouteExtractionResult {
  files: string[]
  /** Deduplicated, each normalised to start with `/` (or `''`). */
  prefixes: string[]
  rawApiRouterCount: number
}

export interface SiblingCoreDirectReport {
  sibling: string
  frontendSrcDir: string
  coreApiSrcDir: string
  frontendFiles: number
  coreFiles: number
  extractedCount: number
  matchedCount: number
  unmatched: ExtractedCoreDirectPath[]
  unresolved: ExtractedCoreDirectPath[]
  corePrefixCount: number
  frontendBlind: boolean
  coreBlind: boolean
  ok: boolean
  summary: string
}

// ── Comment stripping ───────────────────────────────────────────────────────
//
// ONE alternation, scanned left to right, so whichever comment construct
// opens FIRST consumes the other — a two-pass stripper (block pass, then line
// pass) is the exact defect #1374 found: a `/*` appearing as PROSE inside a
// `//` comment gets read as a real block-comment opener by the SECOND pass,
// deleting everything up to the file's next literal `*/`. `tabsii-geo`'s
// `MapView.tsx` carried `// exclude everything under basemap/*) from the S3
// deploy`, which under a two-pass stripper swallowed ~180 lines including
// both of that file's real call sites while reporting a clean pass. One
// alternation, matched greedily by `.exec`'s leftmost-match semantics, gets
// this right in both directions.
//
// The `//` branch requires whitespace or start-of-line before it, not a bare
// `//`, so it does not also truncate a `'https://…'` string literal.
const COMMENT = /\/\*[\s\S]*?\*\/|(?:^|(?<=\s))\/\/[^\n]*/gm

function stripComments(text: string): string {
  return text.replace(COMMENT, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
}

// ── Template literal scanning ───────────────────────────────────────────────
//
// A plain `` `([^`]*)` `` regex stops at the FIRST closing backtick, which is
// the WRONG one whenever the literal contains a nested template literal
// inside its own interpolation — real shape in this estate's sibling repos
// (tabsii-crm's `ops-history-api.ts`, cited in #1330's guard). None of
// `tabsii-intake`'s core-direct call sites nest today, but this scanner
// tracks brace/backtick depth anyway rather than risk a truncated capture
// reading as a real (and wrong) path.
function* templateLiterals(text: string): Generator<{ content: string; start: number }> {
  let i = 0
  const n = text.length
  while (i < n) {
    if (text[i] !== '`') {
      i += 1
      continue
    }
    const start = i + 1
    let j = start
    let depth = 0
    let terminated = false
    while (j < n) {
      const ch = text[j]
      if (ch === '\\') {
        j += 2
        continue
      }
      if (depth === 0 && ch === '`') {
        yield { content: text.slice(start, j), start }
        terminated = true
        break
      }
      if (ch === '$' && j + 1 < n && text[j + 1] === '{') {
        depth += 1
        j += 2
        continue
      }
      if (depth > 0) {
        if (ch === '{') depth += 1
        else if (ch === '}') depth -= 1
      }
      j += 1
    }
    if (!terminated) return // unterminated literal: not a path, not a guess
    i = j + 1
  }
}

function lineNumber(text: string, index: number): number {
  let count = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') count += 1
  }
  return count
}

function touchesConcatenation(text: string, start: number, end: number): boolean {
  const window = 40
  const after = text.slice(end, end + window).replace(/^\s+/, '')
  const before = text.slice(Math.max(0, start - window), start).replace(/\s+$/, '')
  return after.startsWith('+') || before.endsWith('+')
}

/** Replace every BALANCED `${...}` with `{param}`, tracking brace depth so a
 * nested interpolation's own `}` cannot close the outer one early. */
function resolveInterpolations(raw: string): string {
  let out = ''
  let i = 0
  const n = raw.length
  while (i < n) {
    if (raw[i] === '$' && i + 1 < n && raw[i + 1] === '{') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (raw[j] === '{') depth += 1
        else if (raw[j] === '}') depth -= 1
        j += 1
      }
      if (depth > 0) {
        out += raw.slice(i) // never closes: leave as-is, let the caller see the dangling `${`
        break
      }
      out += '{param}'
      i = j
      continue
    }
    out += raw[i]
    i += 1
  }
  return out
}

function isNestedTemplateLiteralArtifact(raw: string): boolean {
  const resolved = resolveInterpolations(raw)
  if (resolved.includes('${')) return true // an interpolation that never closed
  return resolved.includes('\n') // impossible in a real path; a truncation tell
}

function stripQueryString(raw: string): string {
  const idx = raw.indexOf('?')
  return idx === -1 ? raw : raw.slice(0, idx)
}

/** The declared external identifier a literal's LEADING interpolation names,
 * plus everything after it (`rest`) — the part this module actually
 * normalises and matches. `${CORE_API_URL}/api/v1/public/x` must compare as
 * `/api/v1/public/x`, not have its own base identifier turned into
 * `{param}` by the same interpolation-resolution pass that handles the
 * REST of the literal's dynamic segments. */
function externalBaseMatch(
  raw: string,
  externalBases: readonly string[],
): { name: string; rest: string } | null {
  const match = LEADING_INTERPOLATION.exec(raw)
  LEADING_INTERPOLATION.lastIndex = 0 // this regex has no /g flag, but stay defensive
  if (!match) return null
  // Group 1 is a mandatory capture in LEADING_INTERPOLATION (not `(...)?`),
  // so a successful match always populates it.
  const name = match[1] as string
  if (!externalBases.includes(name)) return null
  return { name, rest: raw.slice(match[0].length) }
}

/** Every core-direct call site in `text` — a template literal whose leading
 * interpolation names a declared external base identifier. Anything else
 * (plain BFF-relative literals, references to a LOCAL `const BASE = ...`
 * variable further down the file) is out of scope for this extractor by
 * definition — see the module docstring's "What 'exists on core' means
 * here". Comments are stripped first, so a path merely MENTIONED in one is
 * never mistaken for a call site. */
export function extractCoreDirectPaths(
  rawText: string,
  file: string,
  externalBases: readonly string[] = EXTERNAL_BASE_IDENTIFIERS,
): ExtractedCoreDirectPath[] {
  const text = stripComments(rawText)
  const found: ExtractedCoreDirectPath[] = []

  for (const { content, start } of templateLiterals(text)) {
    const raw = content
    const baseMatch = externalBaseMatch(raw, externalBases)
    if (baseMatch === null) continue
    const { name: base, rest } = baseMatch
    const end = start + content.length

    if (touchesConcatenation(text, start - 1, end + 1)) {
      found.push({
        file,
        line: lineNumber(text, start),
        raw,
        normalized: null,
        unresolvedReason:
          'built with string concatenation (+) — the extracted literal is a fragment, not the whole path',
        externalBase: base,
      })
      continue
    }

    if (isNestedTemplateLiteralArtifact(rest)) {
      found.push({
        file,
        line: lineNumber(text, start),
        raw,
        normalized: null,
        unresolvedReason:
          'contains a template literal nested inside its own interpolation — this ' +
          "extractor's scanner would otherwise truncate at the inner backtick, " +
          'producing a corrupted path rather than a real mismatch',
        externalBase: base,
      })
      continue
    }

    const normalized = stripQueryString(resolveInterpolations(rest))
    found.push({
      file,
      line: lineNumber(text, start),
      raw,
      normalized,
      unresolvedReason: null,
      externalBase: base,
    })
  }

  return found
}

/** Literal `${IDENT}` text occurrences in RAW (unstripped) content, for the
 * blindness backstop — the one count a bug in `stripComments` or
 * `templateLiterals` cannot affect, because it never goes through either. */
export function countRawExternalOccurrences(
  rawText: string,
  externalBases: readonly string[] = EXTERNAL_BASE_IDENTIFIERS,
): number {
  let total = 0
  for (const base of externalBases) {
    const needle = `\${${base}}`
    total += rawText.split(needle).length - 1
  }
  return total
}

function walkFiles(
  root: string,
  accept: (entryName: string) => boolean,
  skipDir: (entryName: string) => boolean,
): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const p = join(dir, entry)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (skipDir(entry)) continue
        walk(p)
        continue
      }
      if (accept(entry)) out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

/** `.ts`/`.tsx` files under `frontendSrcDir`, test files excluded — they
 * mock the API client and would otherwise contribute fixture paths that are
 * never really requested (same exclusion #1330's guard makes, for the same
 * reason). */
export function frontendSourceFiles(frontendSrcDir: string): string[] {
  return walkFiles(
    frontendSrcDir,
    (entry) => /\.(ts|tsx)$/.test(entry) && !TEST_FILE_SUFFIXES.some((s) => entry.endsWith(s)),
    (entry) => entry === 'node_modules' || entry === '.next',
  )
}

export function auditFrontendExtraction(
  frontendSrcDir: string,
  externalBases: readonly string[] = EXTERNAL_BASE_IDENTIFIERS,
): CoreDirectExtractionResult {
  const files = frontendSourceFiles(frontendSrcDir)
  const extracted: ExtractedCoreDirectPath[] = []
  let rawTotal = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    rawTotal += countRawExternalOccurrences(text, externalBases)
    extracted.push(...extractCoreDirectPaths(text, file, externalBases))
  }
  return { files, extracted, rawTotal }
}

// ── Core route-prefix extraction ────────────────────────────────────────────

function balancedParenSpan(text: string, openIndex: number): number | null {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return null
}

/** Every `APIRouter(prefix="...")` this file declares, plus a raw count of
 * every `APIRouter(` call site seen (whether or not it named a prefix) for
 * the blindness backstop. Reads core's Python source directly — never a
 * fixture — so it is only ever as stale as the checkout it is pointed at. */
export function extractCoreRoutePrefixes(pyText: string): CoreRoutePrefixExtraction {
  const prefixes: string[] = []
  let rawApiRouterCount = 0
  const callSite = /APIRouter\s*\(/g
  let m: RegExpExecArray | null
  while ((m = callSite.exec(pyText)) !== null) {
    rawApiRouterCount += 1
    const openParenIndex = m.index + m[0].length - 1
    const closeIndex = balancedParenSpan(pyText, openParenIndex)
    if (closeIndex === null) continue // unterminated call: nothing to extract, still counted above
    const inner = pyText.slice(openParenIndex + 1, closeIndex)
    const prefixMatch = /prefix\s*=\s*["']([^"']*)["']/.exec(inner)
    // Group 1 is mandatory in this pattern too.
    if (prefixMatch) prefixes.push(prefixMatch[1] as string)
  }
  return { prefixes, rawApiRouterCount }
}

function normalizePrefix(prefix: string): string {
  if (prefix === '') return ''
  return prefix.startsWith('/') ? prefix : `/${prefix}`
}

/** `.py` files under `apiSrcDir`, test modules excluded (`tests/` directories
 * and `test_*.py`/`*_test.py` files — the two Python test-discovery
 * conventions `services/api` uses). */
export function coreSourceFiles(apiSrcDir: string): string[] {
  return walkFiles(
    apiSrcDir,
    (entry) => entry.endsWith('.py') && !entry.startsWith('test_') && !entry.endsWith('_test.py'),
    (entry) => entry === 'tests' || entry === '__pycache__',
  )
}

export function auditCoreRouteExtraction(apiSrcDir: string): CoreRouteExtractionResult {
  const files = coreSourceFiles(apiSrcDir)
  const prefixSet = new Set<string>()
  let rawApiRouterCount = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const extraction = extractCoreRoutePrefixes(text)
    rawApiRouterCount += extraction.rawApiRouterCount
    for (const p of extraction.prefixes) prefixSet.add(normalizePrefix(p))
  }
  return { files, prefixes: [...prefixSet].sort(), rawApiRouterCount }
}

/** Does a concrete request for `normalized` dispatch to ANY router core
 * registers? Matched on a `/`-aligned boundary so `/api/v1/public` cannot
 * false-positive-match a route actually registered at `/api/v1/publicity`. */
export function pathMatchesAnyCorePrefix(
  normalized: string,
  corePrefixes: readonly string[],
  apiRoutePrefix: string = API_ROUTE_PREFIX,
): boolean {
  for (const prefix of corePrefixes) {
    const full = `${apiRoutePrefix}${prefix}`
    if (normalized === full || normalized.startsWith(`${full}/`)) return true
  }
  return false
}

/** The whole audit for one sibling: extract its core-direct call sites,
 * extract core's registered route prefixes, and match them — reporting the
 * denominator at every stage (extracted / matched / unmatched / unresolved),
 * never just a pass/fail, for the same reason `AGENTS.md` §2 gives for
 * `staging`: a share with an invisible denominator can always be hiding the
 * cases that were never counted. `ok` folds in BOTH blindness backstops, not
 * just the match/unresolved counts — a report that is blind on either side
 * is never "clean", however many (zero) mismatches it lists. */
export function auditSiblingCoreDirectPaths(params: {
  sibling: string
  frontendSrcDir: string
  coreApiSrcDir: string
  externalBases?: readonly string[]
}): SiblingCoreDirectReport {
  const externalBases = params.externalBases ?? EXTERNAL_BASE_IDENTIFIERS
  const frontend = auditFrontendExtraction(params.frontendSrcDir, externalBases)
  const core = auditCoreRouteExtraction(params.coreApiSrcDir)

  const frontendBlind = frontend.rawTotal > 0 && frontend.extracted.length === 0
  const coreBlind = core.rawApiRouterCount > 0 && core.prefixes.length === 0

  const resolved = frontend.extracted.filter((p) => p.normalized !== null)
  const unresolved = frontend.extracted.filter((p) => p.normalized === null)
  const unmatched = resolved.filter(
    (p) => !pathMatchesAnyCorePrefix(p.normalized as string, core.prefixes),
  )
  const matchedCount = resolved.length - unmatched.length

  const ok = !frontendBlind && !coreBlind && unmatched.length === 0 && unresolved.length === 0

  const summary =
    `${params.sibling}: ${frontend.extracted.length} core-direct call site(s) found under ` +
    `${params.frontendSrcDir} (${frontend.files.length} file(s) scanned); ${matchedCount} ` +
    `matched a route prefix core registers (${core.prefixes.length} prefix(es) from ` +
    `${core.files.length} file(s) under ${params.coreApiSrcDir}), ${unmatched.length} did not, ` +
    `${unresolved.length} could not be resolved at all.`

  return {
    sibling: params.sibling,
    frontendSrcDir: params.frontendSrcDir,
    coreApiSrcDir: params.coreApiSrcDir,
    frontendFiles: frontend.files.length,
    coreFiles: core.files.length,
    extractedCount: frontend.extracted.length,
    matchedCount,
    unmatched,
    unresolved,
    corePrefixCount: core.prefixes.length,
    frontendBlind,
    coreBlind,
    ok,
    summary,
  }
}

/** `auditSiblingCoreDirectPaths`, but throwing with the full detail on
 * failure — the shape a test file wants (`expect(() =>
 * assertSiblingCoreDirectPaths(...)).not.toThrow()`), mirroring
 * `test_every_frontend_api_v1_path_is_registered_on_the_bff`'s assembled
 * failure message in the Python precedent this guard is the other half of. */
export function assertSiblingCoreDirectPaths(
  params: Parameters<typeof auditSiblingCoreDirectPaths>[0],
): SiblingCoreDirectReport {
  const report = auditSiblingCoreDirectPaths(params)
  if (!report.ok) {
    const lines = [report.summary]
    if (report.frontendBlind) {
      lines.push(
        '  BLIND (frontend): raw source contains external-base interpolations but the ' +
          'extractor found none — something is consuming the source before extraction ' +
          'reaches it (#1374 was exactly this shape, on the adjacent guard).',
      )
    }
    if (report.coreBlind) {
      lines.push(
        '  BLIND (core): raw source contains APIRouter(...) call sites but no prefixes ' +
          'were extracted — the extractor broke, this is not evidence core registers nothing.',
      )
    }
    for (const p of report.unmatched) {
      lines.push(
        `  UNMATCHED  ${p.file}:${p.line}  ${JSON.stringify(p.raw)} -> normalised ` +
          `${JSON.stringify(p.normalized)}, no core route prefix matches`,
      )
    }
    for (const p of report.unresolved) {
      lines.push(
        `  UNRESOLVED ${p.file}:${p.line}  ${JSON.stringify(p.raw)} -> ${p.unresolvedReason}`,
      )
    }
    throw new Error(lines.join('\n'))
  }
  return report
}
