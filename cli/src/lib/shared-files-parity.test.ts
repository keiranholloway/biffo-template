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
const manifest = JSON.parse(readFileSync(join(root, 'shared-files.json'), 'utf8')) as {
  files: string[]
  filesIfPresent?: Record<string, string>
  filesFromSkeleton?: Record<string, string>
  skeletonForMarker?: Record<string, string>
  skeletonDefault?: string
}
const sharedFiles: string[] = manifest.files
const conditionalFiles: Record<string, string> = manifest.filesIfPresent ?? {}
const skeletonFiles: Record<string, string> = manifest.filesFromSkeleton ?? {}
const skeletonForMarker: Record<string, string> = manifest.skeletonForMarker ?? {}

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

/**
 * The reverse direction, for `scripts/` ONLY (#1165).
 *
 * The header above declines to assert that every skeleton file appears in the
 * shared set, and that remains right: skeletons carry `ci.yml`, `pyproject.toml`
 * and manifests that a satellite must own and customise. But `scripts/` is not
 * like the rest of the skeleton, for one specific reason:
 *
 * **A script in a skeleton with no distribution channel is frozen at birth,
 * forever, in every repo scaffolded from it.** Nothing ever revisits it, because
 * a skeleton is only exercised when somebody scaffolds. These are governance
 * executables — gates, audits, hook installers — so "frozen" means a repo
 * running a check whose bugs were fixed upstream a year ago and believing it.
 *
 * `scripts/shared-sync.sh` was exactly this and worse: **541 lines against the
 * template's 1137**, and a satellite has no satellites, no `shared-files.json`
 * and nothing to distribute, so the copy could not do anything useful even when
 * current. `tabsii-lms` carries it today. Every reference to it in a satellite
 * points at the TEMPLATE's copy, so the file's only effect was to invite a
 * mistake.
 *
 * The rule: a skeleton's `scripts/` entry is either in the shared set (kept
 * current) or explicitly declared birth-time-seeded below. The allowlist exists
 * so a future legitimate case has a declared home and a written reason, rather
 * than reintroducing this silently.
 */
describe('skeleton scripts/ all have a distribution channel', () => {
  /**
   * Scripts a skeleton may ship WITHOUT being in the shared set, because the
   * satellite is expected to own and diverge them after birth.
   *
   * Empty on purpose. Adding an entry is a decision that this script will never
   * be updated in any repo already scaffolded — say why here.
   */
  const seededAtBirth = new Set<string>([])

  it.each(skeletons)('%s ships no undistributed script', (skeleton) => {
    const dir = join(root, '_skeletons', skeleton, 'scripts')
    const orphans = readdirSync(dir)
      .map((f) => `scripts/${f}`)
      .filter((rel) => !sharedFiles.includes(rel) && !seededAtBirth.has(rel))

    expect(
      orphans,
      `_skeletons/${skeleton} ships script(s) with no distribution channel, so every repo ` +
        `scaffolded from it freezes them at birth (#1165). Either add each to ` +
        `shared-files.json's \`files\`, or declare it in \`seededAtBirth\` with a reason.`,
    ).toEqual([])
  })
})

/**
 * `filesIfPresent` is the OTHER half of the shared set: files kept in step only
 * where they already exist, never created (#1107).
 *
 * The parity rule above cannot apply to them, and asserting it would be wrong
 * rather than merely strict. Their canonical copy IS a skeleton file — a
 * sibling's `apps/frontend/...` has no counterpart at this repo's root — and
 * `plugin-template` has no frontend at all, so demanding every skeleton hold
 * one would make the list unusable for exactly the content it was added for.
 *
 * What must hold instead: the source each entry names actually exists. A typo
 * there is silent — `shared-sync.sh` would `cp` a nonexistent path, `cp`
 * prints to stderr which the script discards, and the repo would receive an
 * empty file or none at all while the run reported success.
 */
describe('shared-files.json filesIfPresent', () => {
  const entries = Object.entries(conditionalFiles)

  it('is a non-empty mapping, so the assertions below are not vacuous', () => {
    expect(entries.length).toBeGreaterThan(0)
  })

  it.each(entries)('%s has a canonical source that exists (%s)', (_target, source) => {
    expect(existsSync(join(root, source)), `${source} does not exist in this repo`).toBe(true)
  })

  it.each(entries)('%s is not also in `files` (%s)', (target) => {
    // Both lists write the same path, with opposite rules about creating it.
    // Whichever ran second would win, and which that is depends on the order of
    // two loops in a shell script.
    expect(sharedFiles).not.toContain(target)
  })
})

/**
 * `filesFromSkeleton` is the THIRD list (#1150): files whose canonical copy is in
 * the SKELETON matching the receiving repo's flavour, and whose policy on an
 * existing copy is per-entry.
 *
 * The `files` parity rule (byte-identical in every skeleton) is deliberately
 * NOT applied here, and applying it would be wrong rather than merely strict:
 * `_skeletons/plugin-template/AGENTS.md` differs from the sibling one by 50 lines
 * of birth-time branch-protection and runner-grant checklist (#714), and it must.
 * That difference is the reason this is a third list rather than `files` learning
 * a `target -> source` remap — a single source cannot express two documents.
 *
 * What must hold instead:
 *
 *  - every skeleton the marker table can select actually holds every entry, or
 *    `shared-sync.sh` would `cp` a nonexistent path into a satellite. `cp`
 *    complains to a stderr the script discards, so the repo receives nothing
 *    while the run reports success — the same silent-empty-copy hazard the
 *    `filesIfPresent` source assertion above exists for;
 *  - the policy is one of the two the script implements, since an unrecognised
 *    third value would silently take the `seed` branch and quietly stop keeping
 *    `AGENTS.md` in step — which is #559 with no symptom;
 *  - no path appears in two lists, for the same reason as above.
 */
describe('shared-files.json filesFromSkeleton', () => {
  const entries = Object.entries(skeletonFiles)
  const sources = [...new Set([...Object.values(skeletonForMarker), manifest.skeletonDefault])]

  it('is a non-empty mapping with a resolvable source for every repo flavour', () => {
    expect(entries.length).toBeGreaterThan(0)
    // Repos with no marker at all — the runner repos, tabsii-map,
    // tabsii-data-model-design — are in scope via `applies()`'s
    // `scripts/verify.sh` clause and resolve through the default. Without one
    // they would silently receive nothing, which is the state #1150 reports.
    expect(manifest.skeletonDefault, 'marker-less repos need a fallback skeleton').toBeTruthy()
    expect(skeletons).toContain(manifest.skeletonDefault)
    for (const skeleton of Object.values(skeletonForMarker)) {
      expect(skeletons, `skeletonForMarker names ${skeleton}`).toContain(skeleton)
    }
  })

  it.each(entries)('%s declares a policy shared-sync.sh implements (%s)', (_path, policy) => {
    expect(['sync', 'seed']).toContain(policy)
  })

  it.each(entries)('%s exists in every selectable skeleton', (path) => {
    for (const skeleton of sources) {
      expect(
        existsSync(join(root, '_skeletons', skeleton as string, path)),
        `_skeletons/${skeleton}/${path} is named as a canonical source but does not exist`,
      ).toBe(true)
    }
  })

  it.each(entries)('%s is in no other list', (path) => {
    expect(sharedFiles).not.toContain(path)
    expect(Object.keys(conditionalFiles)).not.toContain(path)
  })

  it('never sources a satellite ruleset from this repo’s own root copy', () => {
    // The root AGENTS.md/CLAUDE.md carry section 9 template->instance
    // distribution, core-manifest.json and the upgrade flow. None of it applies
    // to a satellite, and distributing them would hand every sibling a document
    // about a boundary it does not have. The skeleton copies are the canonical
    // satellite documents; that they live at the same *basename* as this repo's
    // root ones is exactly the trap.
    for (const [path] of entries) {
      for (const skeleton of sources) {
        expect(
          readFileSync(join(root, '_skeletons', skeleton as string, path), 'utf8'),
        ).not.toEqual(readFileSync(join(root, path), 'utf8'))
      }
    }
  })
})
