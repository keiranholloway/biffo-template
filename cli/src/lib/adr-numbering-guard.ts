import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Detect ADR numbering collisions in one repo's own `docs/ADR/` (tabsii-platform#449).
 *
 * ## Why this exists
 *
 * `docs/ADR/` is user-owned (`core-manifest.json`): the template seeds it once
 * at `biffo init`, then an instance's own ADRs and the template's own
 * subsequent ADRs are two independent, un-synced series that both number from
 * `0001`. An instance author picking "the next free number" by looking at
 * their own directory has no way to know the template will later ship an ADR
 * under that same number — the collision is invisible until it has already
 * happened.
 *
 * This happened for real: tabsii-platform's `0009` and `0010` both carry two
 * unrelated ADRs (`brand-scoped-authorization` / `internal-service-
 * authentication`, `database-enforced-rbac-with-rls` / `event-registry-and-
 * trigger-consolidation`). A third collision was caught only by chance —
 * ADR-0012 was drafted and would have landed on the template's own
 * `0012-identity-provider-seam.md` at the next `core upgrade` — because the
 * author happened to check the template's series before publishing rather
 * than after.
 *
 * ## What this guard checks, and what it deliberately does not
 *
 * It only looks at numeric-prefix collisions **within the repo it runs in**.
 * It cannot see the template's evolving series from an instance's checkout —
 * `docs/ADR/` is excluded from `core upgrade`, so an instance never has a live
 * view of ADRs the template ships after `biffo init`. What it *can* catch is
 * two files landing in the same `docs/ADR/` with the same number — which is
 * exactly the failure mode above, since the template's originally-seeded ADRs
 * are sitting right there in the instance's own directory. A guard that only
 * runs where it can see the collision is still worth having: it is a no-op in
 * the template (one series, no duplicates by construction) and load-bearing in
 * every instance, which is where the two series actually meet.
 *
 * Enforcing an instance-specific convention for *where* new ADRs should be
 * numbered (tabsii's own README documents "continue from ADR-0100") is
 * deliberately out of scope — that is a per-instance policy decision, not a
 * universal template rule.
 *
 * ## The allowlist
 *
 * tabsii-platform's own `0009` and `0010` are a *permanent* collision, not a
 * bug to fix: renumbering touches ~45 code call-sites for "little gain"
 * (`docs/ADR/README.md`), so the decision was to keep the numbers and cite
 * upstream ADRs by title instead. A guard that cannot express "yes, this one
 * is accepted" would either false-positive on every future PR forever, or —
 * worse — get silently disabled, taking every other collision it would have
 * caught down with it.
 *
 * `docs/ADR/.numbering-allowlist` (optional, one four-digit number per line,
 * `#` comments and blank lines ignored) names numbers this check must not
 * flag. It lives under `docs/ADR/` because that directory is user-owned —
 * the allowlist is a per-instance policy decision, exactly like *where* new
 * ADRs get numbered, and editing it never touches template-owned code.
 * `findStaleAdrNumberingAllowlistEntries` is the other half: an allowlisted
 * number that stops colliding (the duplicate was finally renumbered) should
 * be removed, or the allowlist quietly accumulates entries nothing checks
 * against — the same shape as this codebase's `KNOWN_UNSATISFIABLE` guard for
 * RLS grants.
 *
 * ## Does this violate the #325 ownership rule? (#1096)
 *
 * `cli/` is template-owned, so `biffo core upgrade` distributes this guard to
 * every instance — the same distribution channel that turned an unowned
 * `_skeletons/` scan into #325 (a template-owned check reaching a path the
 * instance neither wrote nor could repair). This guard's *subject*,
 * `docs/ADR/`, is declared user-owned in `core-manifest.json` too, which reads
 * the same on paper.
 *
 * It is not the same shape underneath. Every function below takes `adrDir` as
 * a parameter rather than resolving it itself, and the only caller
 * (`cli/src/scripts/check-adr-numbering.ts`) always passes the CURRENT repo's
 * own `docs/ADR/` (`git rev-parse --show-toplevel`, never a path belonging to
 * a different repo). So whichever repo this runs in owns every file it finds,
 * and can fix any real finding — rename a file, add an allowlist entry — by
 * itself, with no upstream release required. That is the discriminator #325
 * actually turns on: an instance receiving an assertion whose subject it
 * cannot receive or repair. `cli/src/lib/template-owned-scope.test.ts`'s
 * `allowedUnowned` mechanism already carves out exactly this shape for
 * `*.instance.yml` (tabsii-platform#521) — content that is user-owned BY
 * DESIGN the moment it exists, fixable directly by whoever owns it. This
 * guard is the same case; it is just not registered in that shared test
 * (`cli/` is outside this PR's file partition — see the PR that introduced
 * this comment for that follow-up).
 *
 * What #1096 actually found live was a *distribution-timing* problem, not a
 * boundary one: a core upgrade that lands this check for the first time can
 * make it fail immediately, on a duplicate the instance did not just create,
 * blocking the upgrade on unrelated cleanup with no grace period. The
 * allowlist above is the fix for that — accept the pre-existing collision in
 * one line instead of completing a renumbering exercise before the upgrade
 * can land.
 *
 * ## The reserved range (#1105)
 *
 * The allowlist only accepts a collision after it exists. `docs/ADR/` in an
 * instance holds two independent, un-synced number series starting at
 * `0001` — the template's, seeded once at `biffo init`, and the instance's
 * own subsequent additions — and an instance author picking "the next free
 * number" by eye has no way to know the template's series will later fill a
 * gap they assumed was theirs. tabsii-platform's own near-miss: ADR-0100 was
 * drafted as `0012` first and would have landed on the template's own
 * `0012-identity-provider-seam.md`, caught only because the author happened
 * to check the template's series before publishing.
 *
 * `TEMPLATE_ADR_RESERVED_UPTO` publishes the boundary — in template-owned
 * code every instance inherits via `biffo core upgrade`, rather than living
 * only in one instance's README, per #1105's explicit ask. `0099` matches
 * tabsii's own already-adopted convention ("continue from ADR-0100"), which
 * already implies exactly this boundary informally. `findAdrReservedRangeViolations`
 * flags any `docs/ADR/` file at or below it — but ONLY when the caller says
 * this is an instance repo (`isInstanceRepo`); the template's own ADRs
 * legitimately sit inside 0001-0099, since that range is defined BY the
 * template's series.
 *
 * This reuses the same `.numbering-allowlist` as the collision check: a
 * number an instance already legitimately holds in the reserved range (e.g.
 * inherited at `biffo init`) is allowlisted the same one-time way tabsii
 * already allowlisted its 0009/0010 collision, rather than retroactively
 * failing on content nobody just touched — the #1096 lesson applied to this
 * check too. It does not eliminate the first-adoption cost entirely: an
 * instance with pre-existing low numbers must seed the allowlist once when it
 * first adopts this check, or CI reds on files it did not just write. A
 * zero-touch ratchet (recording the pre-existing set automatically, the way
 * `biffo.orphan-baseline.json` does for the core-upgrade orphan report) would
 * remove that step, but needs a mutating command — naturally `core upgrade`
 * itself — to do the recording, which is out of this file's scope. Flagged as
 * an open question in the PR that introduced this rather than built here.
 */

/** Two or more files in one `docs/ADR/` claiming the same numeric prefix. */
export interface AdrNumberCollision {
  /** The shared zero-padded number, e.g. "0010". */
  number: string
  /** Filenames claiming it, sorted. */
  files: string[]
}

/** An instance ADR numbered inside the template's reserved range (#1105). */
export interface AdrReservedRangeViolation {
  /** The zero-padded number, e.g. "0012". */
  number: string
  /** The filename claiming it. */
  file: string
}

/** Matches the documented convention: four digits, a hyphen, then the slug. */
const ADR_FILENAME = /^(\d{4})-.+\.md$/

export const ALLOWLIST_FILENAME = '.numbering-allowlist'

/**
 * Numbers at or below this are reserved for the template's own ADR series
 * (#1105). A NEW instance ADR must not be numbered inside this range — see
 * the "The reserved range" section of this file's module doc comment for why.
 * `0099` matches tabsii's own already-adopted convention of continuing its
 * own series from `0100`, published here so every instance inherits the same
 * boundary rather than each guessing or documenting its own.
 */
export const TEMPLATE_ADR_RESERVED_UPTO = '0099'

/**
 * Numbers `docs/ADR/.numbering-allowlist` names as accepted, permanent
 * collisions — a number per line, `#` comments and blank lines ignored.
 * Empty when the file does not exist, which is the common case: an allowlist
 * is the exception, not something every repo needs.
 */
export function readAdrNumberingAllowlist(adrDir: string): Set<string> {
  const path = join(adrDir, ALLOWLIST_FILENAME)
  if (!existsSync(path)) return new Set()

  const numbers = new Set<string>()
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.split('#')[0]!.trim()
    if (line) numbers.add(line)
  }
  return numbers
}

/**
 * Every ADR filename's numeric prefix, mapped to the file(s) claiming it.
 *
 * @param adrDir a `docs/ADR/` directory
 */
export function adrNumbersIn(adrDir: string): Map<string, string[]> {
  const claims = new Map<string, string[]>()
  if (!existsSync(adrDir)) return claims

  for (const entry of readdirSync(adrDir).sort()) {
    const match = ADR_FILENAME.exec(entry)
    if (!match) continue // README.md, template.md, anything non-conforming
    // Group 1 is not optional in ADR_FILENAME, so a successful match always
    // captures it — the non-null assertion reflects that, not an assumption.
    const number = match[1]!
    claims.set(number, [...(claims.get(number) ?? []), entry])
  }
  return claims
}

/**
 * Every number claimed by more than one file, sorted, minus anything
 * `docs/ADR/.numbering-allowlist` names as an accepted, permanent collision.
 */
export function findAdrNumberCollisions(adrDir: string): AdrNumberCollision[] {
  const allowlist = readAdrNumberingAllowlist(adrDir)
  const collisions: AdrNumberCollision[] = []
  for (const [number, files] of [...adrNumbersIn(adrDir).entries()].sort()) {
    if (files.length > 1 && !allowlist.has(number)) {
      collisions.push({ number, files: [...files].sort() })
    }
  }
  return collisions
}

/**
 * Every `docs/ADR/` file numbered at or below `reservedUpTo` (default
 * `TEMPLATE_ADR_RESERVED_UPTO`), minus anything `docs/ADR/.numbering-allowlist`
 * names as an accepted, permanent occupant of the reserved range. Only
 * meaningful for an instance's own `docs/ADR/` — call this only when the
 * caller has established the running repo is an instance (`isInstanceRepo`);
 * in the template, every one of its own ADRs legitimately sits inside the
 * range it defines.
 */
export function findAdrReservedRangeViolations(
  adrDir: string,
  reservedUpTo: string = TEMPLATE_ADR_RESERVED_UPTO,
): AdrReservedRangeViolation[] {
  const allowlist = readAdrNumberingAllowlist(adrDir)
  const violations: AdrReservedRangeViolation[] = []
  for (const [number, files] of [...adrNumbersIn(adrDir).entries()].sort()) {
    if (number > reservedUpTo || allowlist.has(number)) continue
    for (const file of files) violations.push({ number, file })
  }
  return violations
}

/**
 * Allowlisted numbers no longer needed for EITHER reason a number can be on
 * `docs/ADR/.numbering-allowlist`: still colliding, or (per `options`) still
 * landing inside the template's reserved range in an instance repo. Without
 * this, the allowlist only ever grows: nothing else notices when an exception
 * stops being needed.
 *
 * `options` is how the two independent checks that share this one allowlist
 * (`findAdrNumberCollisions`, `findAdrReservedRangeViolations`) both get a say
 * over whether an entry is still earning its place — an entry stale for
 * collision purposes but still inside the reserved range (or vice versa) is
 * not stale at all. Omitting `options` reproduces the collision-only check
 * this function always did before #1105 added the second reason.
 */
export function findStaleAdrNumberingAllowlistEntries(
  adrDir: string,
  options: { reservedUpTo?: string; isInstance?: boolean } = {},
): string[] {
  const allowlist = readAdrNumberingAllowlist(adrDir)
  const claims = adrNumbersIn(adrDir)
  return [...allowlist]
    .filter((number) => {
      const count = claims.get(number)?.length ?? 0
      const stillColliding = count >= 2
      const stillInReservedRange =
        options.isInstance === true &&
        count >= 1 &&
        number <= (options.reservedUpTo ?? TEMPLATE_ADR_RESERVED_UPTO)
      return !stillColliding && !stillInReservedRange
    })
    .sort()
}

/** Human-readable report. */
export function formatAdrNumberCollisions(collisions: AdrNumberCollision[]): string {
  return collisions
    .map(
      (c) =>
        `  ADR-${c.number} is claimed by: ${c.files.join(', ')}\n` +
        `    Pick a different number for the newer one — citing "ADR-${c.number}" is` +
        `\n    ambiguous while both exist.`,
    )
    .join('\n')
}

/** Human-readable report. */
export function formatAdrReservedRangeViolations(
  violations: AdrReservedRangeViolation[],
  reservedUpTo: string = TEMPLATE_ADR_RESERVED_UPTO,
): string {
  return violations
    .map(
      (v) =>
        `  ${v.file} claims ADR-${v.number}, inside 0001-${reservedUpTo} — reserved for the ` +
        `template's own series.\n    Renumber it above ADR-${reservedUpTo}, or if it is meant ` +
        `to be there (e.g. inherited at biffo init), list ${v.number} in ` +
        `docs/ADR/${ALLOWLIST_FILENAME}.`,
    )
    .join('\n')
}
