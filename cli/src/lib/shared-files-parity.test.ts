import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every file in `shared-files.json` must exist, byte-identical, in every
 * skeleton.
 *
 * ## Why
 *
 * `scripts/shared-sync.sh` is a **one-way overwrite**: it compares each
 * satellite's copy against this repo's and pushes ours when they differ. A
 * skeleton that ships a stale or missing copy therefore produces a repo that is
 * born DRIFTED — `--check` reddens the moment somebody scaffolds, and until the
 * sync PR lands that repo is running whatever the skeleton froze.
 *
 * That is not hypothetical. #743: this repo hardened its dependency audits in
 * #591/#592/#636/#717/#721 and both skeletons went on shipping the raw
 * `pnpm audit --audit-level=high` for months, so six siblings and two plugin
 * repos were born reddening a required check on any registry hiccup. Nothing
 * detected it, because a skeleton is only exercised when somebody scaffolds
 * from it.
 *
 * The parity held for the seven files that predate this test — it was simply
 * never asserted, which is the same thing as not holding, one lucky day later.
 *
 * ## What this deliberately does NOT assert
 *
 * That every skeleton file appears in `shared-files.json`. Skeletons carry
 * plenty a satellite must own and customise (`ci.yml`, `pyproject.toml`,
 * manifests). The shared set is the subset that must be **identical**
 * everywhere, and that direction is the only one that is checkable.
 */

/** The repo root — the directory holding `shared-files.json`. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'shared-files.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Resolution failing must FAIL the test, not silence it — a walk that
  // overshoots returns an empty file list and passes against nothing, which is
  // the defect skeleton-drift-guard.test.ts's `skeletonsRoot` already had once.
  throw new Error(`could not locate shared-files.json above ${fileURLToPath(import.meta.url)}`)
}

const root = repoRoot()
const sharedFiles: string[] = JSON.parse(
  readFileSync(join(root, 'shared-files.json'), 'utf8'),
).files

/** Every `_skeletons/<name>` directory, discovered rather than listed. */
const skeletons = readdirSync(join(root, '_skeletons'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(root, '_skeletons', e.name, 'scripts')))
  .map((e) => e.name)

describe('shared-files.json parity with the skeletons', () => {
  it('finds a non-empty shared set and at least both skeletons', () => {
    // Guard the guard: an empty list here would make every assertion below
    // vacuous, and a vacuous green is what #743 looked like for months.
    expect(sharedFiles.length).toBeGreaterThan(0)
    expect(skeletons).toEqual(expect.arrayContaining(['plugin-template', 'sibling-template']))
  })

  it.each(skeletons)('%s carries every shared file, byte-identical', (skeleton) => {
    const missing: string[] = []
    const differing: string[] = []
    for (const rel of sharedFiles) {
      const inSkeleton = join(root, '_skeletons', skeleton, rel)
      if (!existsSync(inSkeleton)) {
        missing.push(rel)
        continue
      }
      if (readFileSync(inSkeleton, 'utf8') !== readFileSync(join(root, rel), 'utf8')) {
        differing.push(rel)
      }
    }
    expect(
      { missing, differing },
      `_skeletons/${skeleton} must hold shared-files.json's entries verbatim, or every repo ` +
        `scaffolded from it is born drifted (#743). Copy them from the repo root.`,
    ).toEqual({ missing: [], differing: [] })
  })
})
