import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const sharedFiles = JSON.parse(readFileSync(join(repoRoot, 'shared-files.json'), 'utf8')) as {
  files: string[]
}
const SKELETONS = ['_skeletons/sibling-template', '_skeletons/plugin-template']

/**
 * Phase 0b of #1109: the first path ever to LEAVE the shared set.
 *
 * `shared-files.json` copied 16 files into 15 repos — roughly 240 copies kept
 * byte-identical by hand, with about ten estate guards written to police them.
 * `wait-for-checks.sh` now ships inside the versioned CLI package and is reached
 * through `scripts/biffo.sh`, so the copies are redundant.
 *
 * Removal and sweep are one change on purpose. Dropping a path from the list
 * only stops it being kept in step — the copies remain and drift silently,
 * unwatched, which is worse than the state being fixed.
 */
describe('wait-for-checks has left the shared set', () => {
  it('is no longer distributed', () => {
    expect(sharedFiles.files).not.toContain('scripts/wait-for-checks.sh')
  })

  it('is gone from both skeletons, so new repos are not born with a copy', () => {
    for (const skeleton of SKELETONS) {
      expect(
        existsSync(join(repoRoot, skeleton, 'scripts/wait-for-checks.sh')),
        `${skeleton} still ships a copy`,
      ).toBe(false)
    }
  })

  it('survives in the template, because that copy is the packaged source', () => {
    // NOT a leftover. `cli/scripts/packaged-root-assets.mjs` copies this file
    // into the tarball at prepack; deleting it would empty the package and
    // break every satellite at once.
    expect(existsSync(join(repoRoot, 'scripts/wait-for-checks.sh'))).toBe(true)
  })
})

describe('the instructions moved before the files did', () => {
  /**
   * AGENTS.md §5 mandates this script by name. Deleting the file while the rule
   * still names it would point every agent in 14 repos at something absent —
   * and `AGENTS.md` is policy `sync`, so the stale text would be actively
   * redistributed. Order matters: instructions first, files second.
   */
  it.each([...SKELETONS.map((s) => `${s}/AGENTS.md`), 'AGENTS.md'])(
    '%s tells agents to use the bridge',
    (path) => {
      const body = readFileSync(join(repoRoot, path), 'utf8')
      expect(body).toContain('sh scripts/biffo.sh wait-for-checks')
    },
  )

  it.each(SKELETONS.map((s) => `${s}/AGENTS.md`))(
    '%s no longer tells agents to run a script the repo does not have',
    (path) => {
      const body = readFileSync(join(repoRoot, path), 'utf8')
      expect(body).not.toContain('sh scripts/wait-for-checks.sh')
    },
  )
})

describe('a satellite that cannot resolve a version says so', () => {
  it('fails closed with an actionable message rather than exit 127', () => {
    // Before #1109 Phase 0b this fell through to `exec cli/node_modules/.bin/tsx`,
    // which does not exist outside the template: exit 127, no output, and 127 is
    // not one of the three values every caller switches on (0/1/2).
    const dir = makeTmpDir('nopin')
    spawnSync('git', ['init', '-q', dir])
    writeFileSync(join(dir, 'biffo.sibling.json'), '{}\n')

    const result = spawnSync('sh', [join(repoRoot, 'scripts/biffo.sh'), 'wait-for-checks', '1'], {
      cwd: dir,
      encoding: 'utf8',
    })

    expect(result.status).toBe(2)
    expect(`${result.stdout}${result.stderr}`).toContain('shared-sync.sh')
  })
})

describe('a sibling is born able to resolve the bridge', () => {
  it('scaffolding stamps .biffo-shared-version in the tag form shared-sync uses', () => {
    // Asserted in the source rather than by scaffolding a whole sibling: that
    // path creates a real GitHub repo and AWS resources. The two producers must
    // agree on the `core-v` prefix, or `biffo.sh` strips nothing and asks npm
    // for `@biffo/cli@core-v0.235.0`, which does not exist.
    const source = readFileSync(join(repoRoot, 'cli/src/commands/sibling-create.ts'), 'utf8')
    expect(source).toContain(".biffo-shared-version'")
    expect(source).toContain('core-v${context.templateVersion')
  })
})
