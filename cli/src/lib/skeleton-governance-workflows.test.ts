import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every skeleton must ship the governance workflows, not just the one that was
 * in front of whoever added them.
 *
 * ## Why this exists
 *
 * `codeql.yml` was added to `_skeletons/sibling-template/` and not to
 * `_skeletons/plugin-template/`, so both plugin repos — **public**, therefore
 * free to scan — had never been analysed at all (#1224). Nothing reported it.
 *
 * The estate's detector for this shape, `shared-sync.sh --candidates`, cannot
 * help: it reports a path only once **5 or more** repos hold it (the threshold
 * is documented at `scripts/shared-sync.sh:553`), and a workflow missing from a
 * skeleton is by definition held by few repos or none. The less adopted a file
 * is, the more invisible it is — the signal runs backwards against need. That
 * blind spot is the class in #1271; 15 of 76 skeleton-owned paths sit inside
 * it.
 *
 * So this guard **enumerates** rather than thresholds. The skeleton list is
 * known — it is whatever `_skeletons/` contains — and a new skeleton is
 * therefore covered the day it is created, without anyone remembering to add it
 * here.
 *
 * Deliberately narrow: only workflows that are governance controls belong in
 * `REQUIRED`, never build steps. A sibling and a plugin legitimately build
 * differently; neither legitimately goes unscanned.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SKELETONS_DIR = join(REPO_ROOT, '_skeletons')

/**
 * Workflows every skeleton must ship, with the reason — so a future reader can
 * judge whether a proposed addition belongs here rather than guessing.
 */
const REQUIRED: Record<string, string> = {
  'codeql.yml':
    'static analysis; public repos scan free, private ones stay dormant behind ENABLE_CODE_SCANNING (#1214, #1224)',
}

/**
 * Repo skeletons, discovered rather than listed — a new one is covered on
 * creation.
 *
 * The discriminator is "ships a CI workflow", not a hardcoded name list.
 * `_skeletons/` also holds `registry/`, which is plugin-registry *content*
 * (`plugins.json` and its schema, consumed by the plugin store) and is not
 * scaffolded into a repo at all. Requiring a security workflow of it would be
 * a false positive; hardcoding the two names would put this guard back to
 * needing a human to remember, which is the failure it exists to prevent.
 */
function skeletons(): string[] {
  return readdirSync(SKELETONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(SKELETONS_DIR, name, '.github', 'workflows', 'ci.yml')))
    .sort()
}

describe('skeleton governance workflows', () => {
  it('finds the skeletons by enumeration, so the guard cannot silently cover none', () => {
    // Without this, a rename of _skeletons/ turns every assertion below into a
    // vacuous pass over an empty list — the fail-open shape #1218 records for
    // verify.sh, and #1270 for the dependency audits.
    const found = skeletons()
    expect(found.length).toBeGreaterThanOrEqual(2)
    expect(found).toContain('sibling-template')
    expect(found).toContain('plugin-template')
    // registry/ is content, not a repo skeleton — see skeletons() above.
    expect(found).not.toContain('registry')
  })

  for (const [workflow, why] of Object.entries(REQUIRED)) {
    describe(`${workflow} — ${why}`, () => {
      for (const skeleton of skeletons()) {
        it(`is shipped by ${skeleton}`, () => {
          const path = join(SKELETONS_DIR, skeleton, '.github', 'workflows', workflow)
          expect(
            existsSync(path),
            `${skeleton} ships no .github/workflows/${workflow}. Repos scaffolded from it inherit the gap, and --candidates cannot see it (#1271).`,
          ).toBe(true)
        })

        it(`${skeleton}'s copy stays dormant on a private repo rather than failing`, () => {
          // A scan that hard-fails where it cannot upload SARIF teaches people
          // to ignore a red check. The opt-in gate is the whole reason this
          // file can be required of every skeleton at all.
          const body = readFileSync(
            join(SKELETONS_DIR, skeleton, '.github', 'workflows', workflow),
            'utf8',
          )
          expect(body).toContain('ENABLE_CODE_SCANNING')
          expect(body).toContain('github.event.repository.private == false')
        })
      }
    })
  }
})
