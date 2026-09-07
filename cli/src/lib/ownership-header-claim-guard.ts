/**
 * A file's own header comment asserting an ownership status
 * (`INSTANCE-OWNED`, `template-owned`, `user-owned`, `NOT a template file`)
 * is a claim nothing ever checked against `core-manifest.json` — the actual
 * authority `isTemplateOwned()` (`core-manifest.ts`) resolves by longest-
 * prefix match (#1911, split from #1362's "a guard reads a different
 * document from the one that acts" class).
 *
 * `scripts/verify-deployed.checks` lived this exact gap (#1706/#1707): its
 * header said `INSTANCE-OWNED`, but `core-manifest.json` disagreed until a
 * human noticed and added the carve-out by hand.
 *
 * ## Why this is not a bare substring sweep
 *
 * `git grep -lE 'INSTANCE-OWNED|template-owned|NOT a template file' --
 * scripts .githooks .github services cli infra` on `origin/dev`
 * (2026-09-04) returns ~150 files containing one of those words. A first
 * implementation matched the same three patterns case-insensitively,
 * anywhere in a file's leading doc-comment/docstring, and took the leftmost
 * match as the file's claim. Run against this repo's REAL tree it produced
 * 45 "disagreements" — and every single one was wrong, in one of two ways:
 *
 * 1. **`cli/` is `released`, not `templateOwned` or `userOwned`** (see
 *    `core-manifest.ts`'s `CoreManifestSchema` doc comment): its source
 *    versions with the core but is never copied into an instance by `biffo
 *    core upgrade` — it ships to npm instead. `isTemplateOwned()` correctly
 *    answers `false` for it (that function only ever means "would an
 *    upgrade copy this"), but a `cli/` file's header calling itself
 *    "template-owned" is ALSO correct, in the ordinary sense the words are
 *    used everywhere else in this repo's prose: it IS template source,
 *    versioned by core, just distributed differently. Comparing a claim of
 *    `template` only against `isTemplateOwned()` treated every one of the
 *    ~35 `cli/src/**` files carrying a header as a disagreement. Fixed by
 *    treating a `template` claim as agreeing when the manifest's OWN
 *    `released` list covers the path too (see `matchesReleased` below) —
 *    `released` is a real ownership status this repo's prose already uses
 *    the word "template-owned" for, and the manifest schema comment says so
 *    explicitly.
 * 2. **Leftmost-in-header is not the same as self-referential.** Several
 *    real files (`scripts/domain_requirements.py`,
 *    `services/api/src/api/identity/__init__.py`,
 *    `services/api/tests/test_domain_requirements.py`, and siblings)
 *    explain ADR-0022's `domains/` carve-out — "an instance's product-domain
 *    code has a **user-owned** home" — before ever describing themselves.
 *    The leftmost keyword in their header is `user-owned`, describing a
 *    DIFFERENT path, while the file itself is ordinary template-owned
 *    tooling. `services/api/src/api/identity/__init__.py` is the sharpest
 *    case: "[domains/] is user-owned (`core-manifest.json`); **this package
 *    is not**" — the correct claim is a NEGATION of the leftmost keyword.
 *    A bare substring/leftmost match cannot tell any of this apart from a
 *    genuine self-claim.
 *
 * Fixed by requiring a real self-referential grammatical marker before
 * `template-owned`/`user-owned` is trusted as a claim (see
 * `SELF_REFERENTIAL_CLAIM` below) — `this/it (+ up to 3 words) is/are/
 * stays/remains (+ optional markdown `**`) template-owned|user-owned`,
 * checked against every real self-declaring header this repo has
 * (`services/api/src/api/domains/__init__.py`'s "This package (...) is
 * **user-owned**", `services/api/src/api/domains/README.md`'s "It is
 * **user-owned**", the agent runtime plugin's "This plugin is
 * template-owned." and "this directory is template-owned") and against
 * every false positive found above (none of which put a self-referential
 * "this/it is" immediately before the word describing a DIFFERENT path,
 * and `identity/__init__.py`'s negation fails to match by construction:
 * "is not, so a provider..." has no `template-owned`/`user-owned` directly
 * after the copula). `INSTANCE-OWNED` and `"NOT a template file"` skip this
 * requirement — see the next section for why they get a different rule.
 *
 * ## The pronoun variant of the same ambiguity (#1959)
 *
 * A bare "this"/"it" is only self-referential when nothing else nearby is a
 * plausible antecedent. `tabsii-platform`'s
 * `services/api/tests/instance/test_boto3_absent_after_import_api_main.py`
 * (a user-owned instance test; the file does not exist in this repo, the
 * ambiguity it exposed does) opened with: "``.../test_api_boto3_lazy_
 * import.py`` already does the same [...] check, but **it is
 * template-owned**" — "it" grammatically refers to the DIFFERENT,
 * template-owned file named earlier in the SAME sentence, not to this
 * docstring's own (correctly user-owned) file. `SELF_REFERENTIAL_CLAIM`
 * alone cannot tell that apart from a genuine "it is X" self-claim, because
 * it never looks at what precedes the match.
 *
 * ### Two rounds of a punctuation heuristic, and why round two was wrong to add
 *
 * #1970's first fix (`sentenceNamesOtherPath`, now removed) tried to bound
 * "the pronoun's own sentence" by walking backward to the nearest preceding
 * paragraph break OR `. ` (period-space), on the theory that a sentence
 * boundary is where a competing antecedent stops counting. Two independent
 * fleet-prosecutor gates each reproduced a live gap in that theory, and both
 * gaps trace to the SAME cause rather than to two unrelated bugs:
 *
 * - **#1971**: `. ` also appears inside an ellipsis (`etc... it is`) and
 *   after an abbreviation. Regex has no way to distinguish those from a real
 *   sentence-ending period, so the boundary walk sometimes lands AFTER the
 *   competing antecedent instead of before it, silently dropping it from the
 *   scanned fragment — reintroducing #1959's exact false-positive shape via
 *   punctuation instead of via a missing check.
 * - **#1972**: the boundary walk's OTHER effect was to suppress every
 *   grammatical match with another path named anywhere earlier in its
 *   "sentence" — including a match whose subject already names a concrete,
 *   unambiguous noun ("this module is user-owned"), which no reasonable
 *   reading would send back to an unrelated path mentioned purely as a
 *   cross-reference. That is a false NEGATIVE: a genuine self-claim silently
 *   disappears.
 *
 * Patching #1971 alone (tighten the period regex to exclude ellipses/
 * abbreviations) would be a second layer of the identical mistake: a regex
 * still cannot reliably tell a real sentence boundary from an abbreviation in
 * general prose, so the next punctuation shape (a mid-sentence quotation, a
 * decimal, a versioned filename) would reopen the same class again. The
 * actual cause both prosecutors named is the same: **no fixed-text scan can
 * reliably parse sentence structure or pronoun antecedents in free-form
 * prose.** So this round removes the sentence-boundary regex outright rather
 * than tightening it, and separately narrows WHEN the antecedent check even
 * applies, rather than adding a fourth special case to WHERE it applies.
 *
 * ### The actual fix: two structural narrowings, not a third special case
 *
 * 1. **No more period-based boundary.** The only boundary a fixed-text scan
 *    can find in prose without trying to interpret punctuation is a blank
 *    line (`\n\s*\n`) — unlike a period, a blank line is never also an
 *    abbreviation, an ellipsis, a decimal or a versioned filename, so there
 *    is no punctuation ambiguity left to get wrong. `otherPathPrecedesBarePronoun`
 *    scopes its scan to the pronoun's own PARAGRAPH (bounded only by blank
 *    lines), never to a period-delimited "sentence". This is coarser than a
 *    real sentence boundary — it can still see a path named in an earlier
 *    sentence of the same paragraph — but coarser-and-reliable beats
 *    finer-and-wrong: it closes #1971 completely, because there is no longer
 *    any punctuation test for an ellipsis or abbreviation to fool.
 * 2. **The antecedent check runs for every match, BARE or QUALIFIED — but
 *    over a different span each time, chosen by what could possibly supply
 *    the claim's grammatical subject.** `SELF_REFERENTIAL_CLAIM` captures
 *    what sits between the pronoun and the copula (its "qualifier" —
 *    `package`, `directory`, `module`, a backtick-quoted own-path
 *    parenthetical, etc.). A BARE pronoun ("this is"/"it is", nothing in
 *    between) supplies no subject of its own at all, so the only place a
 *    competing one can come from is the surrounding prose — it is checked
 *    against its paragraph, exactly as before. A QUALIFIED pronoun ("this
 *    module is", "this package (...) is") supplies its OWN subject, so
 *    nothing outside the match needs checking — but that subject is only
 *    trustworthy if the qualifier's own text doesn't itself embed a
 *    reference to a DIFFERENT path (see "Round three's flaw", below) — so it
 *    is checked too, just over the qualifier text itself rather than the
 *    surrounding paragraph.
 *
 * `domains/__init__.py`'s real docstring mentions the surrounding
 * `services/api/` path in the SAME sentence as its self-claim, but AFTER the
 * copula ("This package (...) is **user-owned** [...] even though it sits
 * inside the template-owned ``services/api/``") — text after the copula is
 * never examined by either check, so that trailing mention never counts as
 * an antecedent and the claim is still read correctly. The qualifier itself
 * ("package (``services/api/src/api/domains/``)") DOES get scanned under the
 * fix below, and DOES contain a path token — but that token is a prefix of
 * the file's own path, so it is excluded as self-reference rather than
 * flagged as a competing one. A cruder header-wide or first-paragraph-only
 * rule (the issue's other suggested mitigation) would also wrongly suppress
 * a genuine self-claim made in a later paragraph than an unrelated path
 * mention — checked directly in the test fixtures below.
 *
 * ### Round three's flaw, and the actual structural fix (#1973)
 *
 * The reasoning above ("a qualified pronoun already carries its own concrete
 * grammatical subject") was half right and half a mistake that a third
 * fleet-prosecutor gate caught: it treated the qualifier's mere PRESENCE —
 * group 1 being non-empty — as proof of being unambiguous, and never once
 * looked at what the qualifier's text actually said. "This package
 * (``services/api/other_module_entirely.py``) is template-owned" has a
 * non-empty qualifier, exactly like "this module is", but its qualifier is
 * an appositive naming a DIFFERENT file — the true grammatical subject of
 * "is" is that other file, not "this package". Trusting non-emptiness as a
 * proxy for unambiguity reproduced #1959's original false-positive shape a
 * third time, just relocated from before the pronoun (round one/two's
 * concern) to inside the qualifier itself.
 *
 * This is not patched by adding a fourth special case ("also reject when the
 * qualifier looks like #1973's example"). The fix is the same structural
 * question rounds one and two already answered correctly for the bare case,
 * applied to the one span round three skipped: **does the text that is
 * actually supposed to supply this claim's subject contain a reference to a
 * different file?** `textNamesOtherPath` (below) is the one check every
 * mechanism in this module now runs — against the paragraph for a bare
 * pronoun (nothing else could supply its subject), against the qualifier
 * text for a qualified one (that IS its subject, so nothing outside it is
 * relevant), and against the text preceding the em-dash for the first-line
 * em-dash convention (see `EM_DASH_FIRST_LINE_CLAIM` below — an em-dash has
 * no subject of its own either, so what precedes it on the line supplies
 * one, and "``other/path.py`` — template-owned, for comparison" is the
 * em-dash sibling of the exact same mistake, found by asking whether the
 * fix generalises rather than by waiting for a fourth issue to report it).
 * Never "is there text here", always "what does the text here actually
 * say" — that is what makes this a removal of round three's flawed
 * assumption rather than a fifth narrowing of it.
 *
 * ## Why `INSTANCE-OWNED` and `template-owned`/`user-owned` are matched
 * differently
 *
 * `INSTANCE-OWNED` (all-caps, hyphenated) and `NOT a template file` are
 * deliberate, shouty marker conventions — nobody writes "INSTANCE-OWNED" in
 * the middle of ordinary prose. Matched case-SENSITIVELY (exactly as #1911's
 * own `git grep -E`, with no `-i`, did) and trusted anywhere in the header
 * with no self-referential-grammar requirement. This distinction is load-
 * bearing, not cosmetic: `services/api/src/api/plugin_baseline_check.py`
 * says, in ordinary prose, "a real multi-tenant instance's own tenant
 * registry is **instance-owned** DDL this module has no visibility into" —
 * lower-case, describing a table this module explicitly does NOT own. A
 * case-INSENSITIVE match on `INSTANCE-OWNED` reads that as a self-claim and
 * flags a false disagreement (this file is ordinary template-owned tooling).
 * Matching the all-caps convention case-sensitively excludes it correctly,
 * with no grammar heuristic needed.
 *
 * ## Bounded header window
 *
 * A Python module docstring can run to dozens of lines describing an
 * entire design (`plugin_baseline_check.py`'s runs past line 40). Reading
 * the WHOLE docstring as "the header" reintroduces the leftmost-anywhere
 * problem one level down — a design essay mentions other paths' ownership
 * constantly. Every real self-declaring header in this repo states its
 * claim within its first ~10 lines, so the header window actually scanned
 * for a claim is capped there (`MAX_HEADER_LINES`) regardless of how long
 * the underlying comment/docstring block actually runs.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isTemplateOwned, type CoreManifest } from './core-manifest.js'
import { gitTrackedFiles, type GitRunner } from './git-tracked-files.js'

/** The directories `git grep`'d in #1911 — kept identical to that scope. */
export const OWNERSHIP_HEADER_SWEEP_DIRS = [
  'scripts',
  '.githooks',
  '.github',
  'services',
  'cli',
  'infra',
] as const

export type OwnershipClaim = 'template' | 'user'

export interface HeaderClaimHit {
  /** Repo-relative posix path. */
  path: string
  claim: OwnershipClaim
  /** The exact substring that produced the claim, for the failure message. */
  matchedPhrase: string
  /** 1-indexed line the claim was found on. */
  line: number
}

export interface OwnershipHeaderDisagreement extends HeaderClaimHit {
  manifestSaysTemplateOwned: boolean
}

/** Deliberate, shouty marker conventions — matched case-SENSITIVELY, exactly
 * as #1911's own `git grep -E` (no `-i`) did, and trusted anywhere in the
 * header with no further grammatical qualification. See the module doc
 * comment for why lower-case "instance-owned" in ordinary prose must NOT
 * match this (`plugin_baseline_check.py`).
 *
 * Excludes a match wrapped in a markdown code span (`` `INSTANCE-OWNED` ``,
 * `` `NOT a template file` ``) via a lookbehind/lookahead on the backtick —
 * this guard's OWN two source files falsify "nobody writes 'INSTANCE-OWNED'
 * in the middle of ordinary prose" (biffo-template#1937): both quote the
 * marker, backtick-wrapped, in a comma-separated list of the four patterns
 * this module looks for (see this file's own module doc comment, line 3, and
 * `check-ownership-header-claim.ts`'s), which is meta-discussion of the
 * convention, not a live self-claim using it. Every real self-claim in this
 * guard's corpus (`scripts/verify-deployed.checks`, the Python-docstring and
 * shell-script test fixtures below) writes the marker bare, with no
 * surrounding backticks — a real claim uses the shouty convention directly;
 * a code span around it is someone quoting the convention BY NAME. */
const STRICT_MARKER = /(?<!`)(?:INSTANCE-OWNED|NOT a template file)(?!`)/

/**
 * `template-owned`/`user-owned` trusted as a claim only when immediately
 * preceded by a self-referential subject and copula — `this`/`it`, up to 3
 * further words (a noun like "package"/"plugin"/"directory", or a
 * backtick-quoted path with no internal spaces), then `is`/`are`/`stays`/
 * `remains`, then (optionally) markdown `**`, then the claim word itself.
 * See the module doc comment for the real corpus this was checked against.
 *
 * Group 1 captures the "qualifier" — whatever sits between the pronoun and
 * the copula, possibly nothing (an empty string, when `this`/`it` is
 * immediately followed by the copula). `claimInText` uses whether group 1 is
 * empty to decide WHERE to check for a competing path, not WHETHER to check:
 * a BARE pronoun is checked against its paragraph (see
 * `otherPathPrecedesBarePronoun`, since nothing else can supply its
 * subject); a QUALIFIED one is checked against its own captured qualifier
 * text instead (see `textNamesOtherPath`, since the qualifier IS its
 * subject, and #1973 showed that subject is only trustworthy when it
 * doesn't itself embed a different file). See the module doc comment's
 * "Round three's flaw" section. Group 2 is the claim word itself.
 *
 * Global (`g`) so `claimInText` can walk PAST a match rejected as an
 * ambiguous bare pronoun to look for a later, genuinely self-referential one
 * — callers MUST reset `.lastIndex = 0` before each fresh piece of text,
 * since this is a shared module-level regex object and stale state from one
 * file would otherwise corrupt matching on the next.
 */
const SELF_REFERENTIAL_CLAIM =
  /\b(?:[Tt]his|[Ii]t)\b((?:\s+\S+){0,3})\s+(?:is|are|stays|remains)\s+(?:\*\*)?(template-owned|user-owned)\b/g

/**
 * A path-shaped token: ordinary path characters (letters, digits,
 * `_.-`) either side of at least one `/`, optionally wrapped in up to two
 * backticks — this repo's own convention for naming a path bare
 * (Markdown/TS prose, `services/api/...`) or RST-literal-quoted (Python
 * docstrings, ``services/api/...``). Deliberately narrower than "any
 * non-whitespace run containing a slash": that first cut matched a bare
 * `/**` JSDoc comment-opener as a two-character "path" (`/` then `**`),
 * which cost the `instance-adoption.ts`-style fixture a real self-claim —
 * requiring a path character (not `*`, `(`, `,` etc.) immediately before
 * the `/` excludes it. Used only to find a plausible pronoun antecedent
 * within a single sentence, not as a general path validator.
 */
const PATH_TOKEN = /`{0,2}([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*)`{0,2}/g

/** Strips the punctuation a path token picks up from ordinary sentence
 * position: a leading opening paren, and a trailing closing paren/comma/
 * semicolon/colon/sentence-ending period — the last of these matters
 * because `.` is itself a valid path character (`PATH_TOKEN` has to allow
 * it for `.py`/`.ts` extensions), so "...scripts/verify-deployed.checks."
 * at the end of a sentence is captured WITH the trailing period and must
 * have it stripped back off. Deliberately excludes `/` from the trailing
 * class — a real directory reference legitimately ends in one
 * (`services/api/src/api/domains/`) and stripping it would be wrong, even
 * though no current fixture's comparison depends on keeping it. */
function stripPathPunctuation(token: string): string {
  return token.replace(/^[(,;:]+/, '').replace(/[),;:.]+$/, '')
}

/**
 * Whether `text` names a path OTHER than `ownPath` — the one structural
 * question every mechanism in this module needs answered, applied to
 * whatever span of text actually claims to supply (or fails to supply) a
 * match's grammatical subject. See the module doc comment's "Round three's
 * flaw" section for why this single check, applied to three different
 * spans, replaced three separately-reasoned special cases: the SAME
 * function is called with a bare pronoun's paragraph
 * (`otherPathPrecedesBarePronoun`), a qualified pronoun's own captured
 * qualifier (`claimInText`), and the text preceding a first-line em-dash
 * (`claimInText` again) — never with anything wider, and never skipped
 * because the span happened to be non-empty.
 */
function textNamesOtherPath(text: string, ownPath: string): boolean {
  PATH_TOKEN.lastIndex = 0
  let tokenMatch: RegExpExecArray | null
  while ((tokenMatch = PATH_TOKEN.exec(text))) {
    const token = stripPathPunctuation(tokenMatch[1]!)
    if (!token.includes('/')) continue
    if (token === ownPath || ownPath.startsWith(token) || token.startsWith(ownPath)) continue
    return true
  }
  return false
}

/**
 * Whether a path OTHER than `ownPath` is named earlier in the same PARAGRAPH
 * as a BARE pronoun match at `pronounIndex` — in which case "this"/"it" most
 * plausibly refers to THAT path, not to the containing file. Only ever
 * called for a bare pronoun (see `claimInText`); a qualified one ("this
 * module", "this package (...)") is checked a different way — see
 * `textNamesOtherPath` and the module doc comment's "Round three's flaw"
 * section.
 *
 * Scoped to the paragraph (bounded only by the nearest preceding blank line,
 * `\n\s*\n`) rather than to a period-delimited "sentence". A blank line is
 * the one boundary a fixed-text scan can find without trying to interpret
 * prose punctuation — unlike a period, it is never also an abbreviation, an
 * ellipsis, a decimal or part of a versioned filename, so there is no
 * boundary-detection heuristic left to fool (#1971 was exactly that: `. `
 * misread inside `etc...`). This is coarser than a real sentence boundary —
 * it can still see a path named in an earlier sentence of the same
 * paragraph — but a path named AFTER the pronoun (as in the real
 * `domains/__init__.py` header) is never examined at all, and a path named
 * in an EARLIER, separate paragraph must never suppress a later, genuine
 * self-claim — both checked directly in the test fixtures below.
 */
function otherPathPrecedesBarePronoun(
  text: string,
  pronounIndex: number,
  ownPath: string,
): boolean {
  const before = text.slice(0, pronounIndex)
  const paragraphBreak = /\n\s*\n/g
  let paragraphStart = 0
  let breakMatch: RegExpExecArray | null
  while ((breakMatch = paragraphBreak.exec(before))) {
    paragraphStart = breakMatch.index + breakMatch[0].length
  }
  const paragraph = text.slice(paragraphStart, pronounIndex)
  return textNamesOtherPath(paragraph, ownPath)
}

/**
 * The other real self-declaring convention that has no explicit copula:
 * "<short description> — template-owned, like ..." (`infra/environments/
 * dev/artifacts.core.tf`) and "<description>. INSTANCE-OWNED — ..."
 * (`scripts/verify-deployed.checks`, already covered by `STRICT_MARKER`
 * itself). Deliberately restricted to the header's OWN FIRST LINE — every
 * real instance of it sits there, and every false-positive checked against
 * this guard's real corpus (`scripts/domain_requirements.py`,
 * `services/api/src/api/identity/__init__.py` and siblings) puts its
 * unrelated mention of a DIFFERENT path's ownership several lines further
 * in, past a title/summary line naming the actual subject. Restricting to
 * line 1 only narrows WHERE a false positive could hide; it does not by
 * itself rule one out — "``other/path.py`` — template-owned, for
 * comparison" is a real, constructible line-1 shape that names a different
 * file right before the dash, so `claimInText` also runs
 * `textNamesOtherPath` over the text preceding the matched dash, the same
 * check applied to a qualified pronoun's qualifier (see the module doc
 * comment's "Round three's flaw" section) — an em-dash supplies no subject
 * of its own either, so what precedes it on the line is what must be
 * checked.
 */
const EM_DASH_FIRST_LINE_CLAIM = /[—–]\s*(template-owned|user-owned)\b/

/** Cap on how far into a header (in lines, from its own start) a claim is
 * trusted from — see the module doc comment's "Bounded header window". */
const MAX_HEADER_LINES = 10

function claimFor(matchedPhrase: string): OwnershipClaim {
  return /^template-owned$/i.test(matchedPhrase) ? 'template' : 'user'
}

interface ClaimMatch {
  matchedPhrase: string
  claim: OwnershipClaim
  index: number
}

/**
 * The claim in one header-window's worth of text, or `null` — the leftmost
 * match across all three mechanisms (strict marker, self-referential
 * grammar, first-line em-dash). See the module doc comment for the corpus
 * each was checked against. `ownPath` is the containing file's own path,
 * used only to resolve the self-referential-grammar mechanism's pronoun
 * ambiguity (see `otherPathPrecedesBarePronoun`).
 */
function claimInText(text: string, ownPath: string): ClaimMatch | null {
  const candidates: ClaimMatch[] = []

  const strict = STRICT_MARKER.exec(text)
  if (strict)
    candidates.push({ matchedPhrase: strict[0], claim: claimFor(strict[0]), index: strict.index })

  // Global regex, shared module-level object — reset before every fresh
  // piece of text (see SELF_REFERENTIAL_CLAIM's own doc comment).
  SELF_REFERENTIAL_CLAIM.lastIndex = 0
  let grammatical: RegExpExecArray | null
  while ((grammatical = SELF_REFERENTIAL_CLAIM.exec(text))) {
    // Group 1 (the qualifier) and group 2 (the claim word) are both mandatory
    // capturing groups in SELF_REFERENTIAL_CLAIM (neither is inside an
    // alternation that could omit it), so both are always present when the
    // overall match succeeds — the `!`s reflect that, not a shortcut around
    // `noUncheckedIndexedAccess`'s generic array-index rule. An empty group 1
    // means a BARE pronoun ("this is"/"it is"): nothing supplies its subject
    // except the surrounding prose, so it is checked against its paragraph.
    // A non-empty group 1 ("this module is", "this package (...) is") IS its
    // own subject — but #1973 showed that subject is only trustworthy when
    // it doesn't itself embed a reference to a different path, so it gets
    // the same `textNamesOtherPath` check applied to its own captured text
    // instead of the paragraph. See SELF_REFERENTIAL_CLAIM's own doc comment
    // and the module doc comment's "Round three's flaw" section.
    const qualifier = grammatical[1]!
    const isBarePronoun = qualifier === ''
    if (isBarePronoun) {
      if (otherPathPrecedesBarePronoun(text, grammatical.index, ownPath)) continue
    } else if (textNamesOtherPath(qualifier, ownPath)) {
      continue
    }
    const phrase = grammatical[2]!
    candidates.push({ matchedPhrase: phrase, claim: claimFor(phrase), index: grammatical.index })
    break
  }

  const firstLine = text.split('\n', 1)[0] ?? ''
  const emDash = EM_DASH_FIRST_LINE_CLAIM.exec(firstLine)
  // An em-dash supplies no subject of its own either — what precedes it on
  // the line is what must actually be about this file (see
  // EM_DASH_FIRST_LINE_CLAIM's own doc comment and the module doc comment's
  // "Round three's flaw" section for why this is the same check as the
  // qualifier one above, not a fifth special case).
  if (emDash && !textNamesOtherPath(firstLine.slice(0, emDash.index), ownPath)) {
    // Same reasoning as above: group 1 is mandatory in EM_DASH_FIRST_LINE_CLAIM.
    const phrase = emDash[1]!
    candidates.push({ matchedPhrase: phrase, claim: claimFor(phrase), index: emDash.index })
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.index - b.index)
  return candidates[0] ?? null
}

function fileExtension(path: string): string {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  return dot > slash ? path.slice(dot).toLowerCase() : ''
}

function isCommentLine(line: string): boolean {
  return line.trim().startsWith('#')
}

/** `lines[i]`, defaulting to `''` — every call site below only ever indexes
 * within a bound its own loop condition already checked, so the fallback is
 * unreachable in practice; this only exists to satisfy
 * `noUncheckedIndexedAccess` without scattering non-null assertions across
 * ordinary bounded-loop array access. */
function lineAt(lines: readonly string[], i: number): string {
  return lines[i] ?? ''
}

/**
 * End index (exclusive) of the leading `#`-comment run starting at `start`.
 * Blank lines are tolerated only as a paragraph break INSIDE the comment
 * block — i.e. only when a further comment line follows before any real
 * content does — so a genuinely blank line preceding code (the overwhelming
 * common case: a shebang or `#!/usr/bin/env` line, then blank, then code)
 * correctly ends the header rather than swallowing the rest of the file.
 */
function leadingHashCommentEnd(lines: string[], start: number): number {
  let i = start
  while (i < lines.length) {
    if (isCommentLine(lineAt(lines, i))) {
      i++
      continue
    }
    if (lineAt(lines, i).trim() === '') {
      let j = i + 1
      while (j < lines.length && lineAt(lines, j).trim() === '') j++
      if (j < lines.length && isCommentLine(lineAt(lines, j))) {
        i = j
        continue
      }
      return i
    }
    return i
  }
  return i
}

/** `.sh`, `.tf`, `.yml`/`.yaml`, and extensionless shell-style files
 * (`.githooks/commit-msg`, `scripts/verify-deployed.checks`). */
function defaultHeaderRange(lines: string[]): [number, number] | null {
  const start = lineAt(lines, 0).startsWith('#!') ? 1 : 0
  const end = leadingHashCommentEnd(lines, start)
  return end > start ? [start, end] : null
}

function pythonHeaderRange(lines: string[]): [number, number] | null {
  let i = lineAt(lines, 0).startsWith('#!') ? 1 : 0
  while (i < lines.length && lineAt(lines, i).trim() === '') i++
  if (i >= lines.length) return null
  const first = lineAt(lines, i)
  const trimmed = first.trimStart()
  const quote = trimmed.startsWith('"""') ? '"""' : trimmed.startsWith("'''") ? "'''" : null
  if (quote) {
    const afterOpen = first.slice(first.indexOf(quote) + 3)
    if (afterOpen.includes(quote)) return [i, i + 1]
    let j = i + 1
    while (j < lines.length && !lineAt(lines, j).includes(quote)) j++
    return [i, Math.min(j + 1, lines.length)]
  }
  const end = leadingHashCommentEnd(lines, i)
  return end > i ? [i, end] : null
}

/**
 * TS/JS/MJS: the header is the first JSDoc-style block comment (opening
 * `/**`) or a leading `//` line comment, allowed to be preceded by blank
 * lines and `import` statements — the convention this repo actually uses
 * (`instance-adoption.ts`, `python-test-scope-scan.ts`,
 * `template-shipped-paths.ts` all put their module doc-comment after
 * their imports).
 */
function jsHeaderRange(lines: string[]): [number, number] | null {
  let i = 0
  while (
    i < lines.length &&
    (lineAt(lines, i).trim() === '' || lineAt(lines, i).trim().startsWith('import '))
  ) {
    i++
  }
  if (i >= lines.length) return null
  const first = lineAt(lines, i).trim()
  if (first.startsWith('/*')) {
    let j = i
    while (j < lines.length && !lineAt(lines, j).includes('*/')) j++
    return [i, Math.min(j + 1, lines.length)]
  }
  if (first.startsWith('//')) {
    let j = i
    while (
      j < lines.length &&
      (lineAt(lines, j).trim().startsWith('//') || lineAt(lines, j).trim() === '')
    )
      j++
    return [i, j]
  }
  return null
}

function headerRange(path: string, lines: string[]): [number, number] | null {
  const ext = fileExtension(path)
  let range: [number, number] | null
  if (ext === '.py') range = pythonHeaderRange(lines)
  else if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.mjs')
    range = jsHeaderRange(lines)
  else if (ext === '.md')
    // Markdown has no comment syntax to bound a header with; the lead
    // paragraph (the only place a real self-claim was ever found — the agent
    // runtime plugin's terraform README states it five lines in) is a
    // bounded, testable proxy rather than the whole file.
    range = [0, Math.min(15, lines.length)]
  else if (ext === '.json')
    return null // handled separately, see findJsonDescriptionClaim
  else range = defaultHeaderRange(lines)

  if (!range) return null
  const [start, end] = range
  return [start, Math.min(end, start + MAX_HEADER_LINES)]
}

function findJsonDescriptionClaim(path: string, content: string): HeaderClaimHit | null {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const description = (data as Record<string, unknown>)['description']
  if (typeof description !== 'string') return null
  // A manifest's own "description" field is inherently about the artifact
  // it describes — there is no OTHER path it could be talking about the way
  // a module docstring can digress to explain a sibling carve-out — so the
  // strict-marker/self-referential-grammar split above does not apply here:
  // any of the four patterns anywhere in the description is trustworthy.
  const match = /INSTANCE-OWNED|NOT a template file|user-owned|template-owned/i.exec(description)
  if (!match) return null
  const lineIndex = content.split('\n').findIndex((l) => l.includes('"description"'))
  return {
    path,
    claim: claimFor(match[0]),
    matchedPhrase: match[0],
    line: lineIndex === -1 ? 1 : lineIndex + 1,
  }
}

/**
 * The single ownership-style claim a file's own header makes, or `null` if
 * it makes none. See the module doc comment for the full corpus-derived
 * reasoning behind the strict-marker/self-referential-grammar split, the
 * `released`-list handling (that lives in `checkOwnershipHeaderClaims`, not
 * here — this function only ever reads the header, never the manifest), and
 * the bounded header window.
 */
export function findHeaderClaim(path: string, content: string): HeaderClaimHit | null {
  if (fileExtension(path) === '.json') return findJsonDescriptionClaim(path, content)

  const lines = content.split('\n')
  const range = headerRange(path, lines)
  if (!range) return null
  const [start, end] = range
  const windowText = lines.slice(start, end).join('\n')
  const found = claimInText(windowText, path)
  if (!found) return null
  const line = start + windowText.slice(0, found.index).split('\n').length
  return { path, claim: found.claim, matchedPhrase: found.matchedPhrase, line }
}

export interface SweepOptions {
  git?: GitRunner
}

/**
 * Every header-claim hit under the swept directories, git-tracked files
 * only (so a build artifact or an operator's untracked scratch file is never
 * part of the answer — the same discipline `listTemplateOwnedFiles` applies).
 * Returns an empty array, rather than throwing, when `root` is not a git
 * worktree the caller can enumerate — the CI entrypoint refuses a zero-hit
 * result outright (see its own doc comment) rather than reporting it clean.
 */
export function sweepOwnershipHeaderClaims(
  root: string,
  options: SweepOptions = {},
): HeaderClaimHit[] {
  const tracked = options.git ? gitTrackedFiles(root, options.git) : gitTrackedFiles(root)
  if (!tracked) return []

  const files = [...tracked]
    .filter((p) => OWNERSHIP_HEADER_SWEEP_DIRS.some((dir) => p === dir || p.startsWith(`${dir}/`)))
    .sort()

  const hits: HeaderClaimHit[] = []
  for (const rel of files) {
    let content: string
    try {
      content = readFileSync(join(root, rel), 'utf8')
    } catch {
      continue
    }
    const hit = findHeaderClaim(rel, content)
    if (hit) hits.push(hit)
  }
  return hits
}

/** Whether `manifest.released` covers `relPath` — a flat pathspec-prefix
 * list (mirrors how `core-tags.ts`'s `templateVersionedPathspecs` already
 * treats it: passed straight through as `git diff -- <pathspecs>`, never run
 * through the glob/longest-prefix machinery `isTemplateOwned` uses for
 * `templateOwned`/`userOwned`). `cli/` is the one entry today; see the
 * module doc comment for why a `template` claim on a `released` path is
 * correct rather than a disagreement. */
function matchesReleased(relPath: string, manifest: CoreManifest): boolean {
  return (manifest.released ?? []).some((p) => relPath === p || relPath.startsWith(p))
}

/**
 * Which of `hits` disagree with `manifest`'s real ownership answer.
 * `isTemplateOwned` (`core-manifest.ts`) is the one authority for the
 * `templateOwned`/`userOwned` split (longest-prefix match; this module only
 * ever reads it, never re-derives it) — but a `template` claim ALSO agrees
 * when `manifest.released` covers the path (see `matchesReleased` and the
 * module doc comment's `cli/` case): `released` is a third, real ownership
 * status this repo's own prose already calls "template-owned".
 *
 * The `released` carve-out is deliberately ONE-SIDED: it only ever widens
 * agreement for a `'template'` claim, never for a `'user'` claim
 * (biffo-template#1937). `matchesReleased` being `true` says "this path's
 * source versions with the core", which is what makes a `template-owned`
 * self-claim correct there — it says nothing about a `user-owned`/
 * `INSTANCE-OWNED` self-claim being correct too, and a released path is
 * exactly where such a claim would be a real drift (`isTemplateOwned` is
 * `false` for `released`-only paths, so before this fix `!manifestSaysTemplateOwned`
 * alone made every `'user'` claim under a `released` path agree
 * unconditionally, regardless of what the header actually said). So a
 * `'user'` claim agrees only when the manifest says neither
 * `templateOwned` NOR `released`.
 */
export function checkOwnershipHeaderClaims(
  hits: readonly HeaderClaimHit[],
  manifest: CoreManifest,
): OwnershipHeaderDisagreement[] {
  const out: OwnershipHeaderDisagreement[] = []
  for (const hit of hits) {
    const manifestSaysTemplateOwned = isTemplateOwned(hit.path, manifest)
    const released = matchesReleased(hit.path, manifest)
    const agrees =
      hit.claim === 'template'
        ? manifestSaysTemplateOwned || released
        : !manifestSaysTemplateOwned && !released
    if (!agrees) {
      out.push({ ...hit, manifestSaysTemplateOwned })
    }
  }
  return out
}
