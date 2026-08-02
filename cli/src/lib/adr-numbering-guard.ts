import { existsSync, readdirSync } from 'node:fs'

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
 */

/** Two or more files in one `docs/ADR/` claiming the same numeric prefix. */
export interface AdrNumberCollision {
  /** The shared zero-padded number, e.g. "0010". */
  number: string
  /** Filenames claiming it, sorted. */
  files: string[]
}

/** Matches the documented convention: four digits, a hyphen, then the slug. */
const ADR_FILENAME = /^(\d{4})-.+\.md$/

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

/** Every number claimed by more than one file, sorted. */
export function findAdrNumberCollisions(adrDir: string): AdrNumberCollision[] {
  const collisions: AdrNumberCollision[] = []
  for (const [number, files] of [...adrNumbersIn(adrDir).entries()].sort()) {
    if (files.length > 1) collisions.push({ number, files: [...files].sort() })
  }
  return collisions
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
