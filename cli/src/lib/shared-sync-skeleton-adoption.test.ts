import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { anchorToOrigin, realSharedSync } from '../test-utils/shared-sync-template.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `--skeleton-adoption` is the fix for the REPORT half of #1271: `--candidates`
 * requires a path in >=5 repos before it reports it (the threshold is
 * documented at `scripts/shared-sync.sh:553`), so a file the skeleton gained
 * recently -- which few or no siblings have adopted -- is invisible, and the
 * fewer repos that hold it the LESS visible it is.
 *
 * This mode enumerates instead: the skeleton's file list is already known, so
 * for every path it owns it counts holders across the repos that skeleton
 * applies to and reports any not held by ALL of them. No threshold, so unlike
 * `--backfill` it does not drop the "held by nobody" case as scaffolding --
 * for adoption tracking specifically, 0 holders is the loudest signal there
 * is, and the issue's own measured example (`apps/frontend/e2e/smoke.spec.ts`
 * at 0/7) is exactly that case.
 *
 * These tests run the real script against a fixture template and estate
 * rather than this repo's own skeletons, so they assert the mechanism's rules
 * rather than today's estate contents, which change weekly.
 */
const GIT_ENV = ['-c', 'user.email=t@t', '-c', 'user.name=t']

function commitAll(dir: string): void {
  execFileSync('git', ['-C', dir, 'add', '-A'])
  execFileSync('git', ['-C', dir, ...GIT_ENV, 'commit', '-q', '-m', 'seed'])
}

/**
 * A satellite whose `origin/dev` holds exactly `files`, plus its marker.
 * Pushed to a bare origin, because the script reads `origin/<base>` refs and
 * never a working tree.
 */
function satellite(estate: string, name: string, marker: string, files: string[]): void {
  const origin = join(estate, `${name}.git`)
  execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', origin])
  const dir = join(estate, name)
  execFileSync('git', ['init', '-q', '-b', 'dev', dir])
  writeFileSync(join(dir, marker), '{}\n')
  // Every in-scope repo needs the bridge for `applies()` to select it. It was
  // `scripts/verify.sh` until #1241 moved that file into the CLI package and
  // swept the satellites' copies.
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'biffo.sh'), '#!/bin/sh\n')
  // Every fixture repo carries the skeleton's own ci.yml, matching real
  // repos, so it does not itself show up as an unrelated 0-holder gap in
  // every assertion below -- the tests below are about the files they
  // deliberately vary, not about a fixture artefact of the discriminator.
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\n')
  for (const rel of files) {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(join(dir, rel), `${rel}\n`)
  }
  commitAll(dir)
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin])
  execFileSync('git', ['-C', dir, 'push', '-q', '-u', 'origin', 'dev'])
}

interface SkeletonSpec {
  files: string[]
  /** Whether this skeleton ships `.github/workflows/ci.yml` -- the
   * discriminator the report uses to decide "this is a repo skeleton" rather
   * than registry-style content. Defaults to true. */
  ci?: boolean
}

/**
 * A template checkout carrying the real script, a manifest, and one or more
 * skeletons under `_skeletons/<name>/`.
 */
function template(root: string, skeletons: Record<string, SkeletonSpec>, manifest: object): string {
  const dir = join(root, 'template')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'dev', dir])
  cpSync(realSharedSync, join(dir, 'scripts', 'shared-sync.sh'))
  writeFileSync(join(dir, 'shared-files.json'), JSON.stringify(manifest, null, 2))
  for (const [name, spec] of Object.entries(skeletons)) {
    if (spec.ci !== false) {
      const ciPath = join(dir, '_skeletons', name, '.github', 'workflows', 'ci.yml')
      mkdirSync(join(ciPath, '..'), { recursive: true })
      writeFileSync(ciPath, 'name: CI\non: push\n')
    }
    for (const rel of spec.files) {
      const full = join(dir, '_skeletons', name, rel)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, `${rel}\n`)
    }
  }
  commitAll(dir)
  // The fixture template sits on `dev`, so shared-sync's staleness preflight
  // applies to it. Anchor it to its own origin so the fixture decides that
  // question rather than landing on whichever branch of the preflight an
  // unreachable remote happens to take (#1252).
  anchorToOrigin(dir)
  return dir
}

const MANIFEST = {
  files: ['scripts/verify.sh'],
  filesFromSkeleton: {},
  skeletonForMarker: { 'biffo.sibling.json': 'sibling-template' },
  skeletonDefault: 'sibling-template',
}

function runAdoption(templateDir: string, estate: string): { out: string; status: number } {
  try {
    const out = execFileSync(
      'sh',
      [join(templateDir, 'scripts', 'shared-sync.sh'), '--skeleton-adoption', '--estate', estate],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return { out, status: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, status: e.status ?? -1 }
  }
}

describe('shared-sync.sh --skeleton-adoption', () => {
  it('reports a path held by nobody, unlike --backfill', () => {
    // `--backfill` drops the 0-holders case as scaffolding a repo consumes or
    // renames at birth. Adoption tracking cannot make that assumption -- the
    // issue's own measured example is `apps/frontend/e2e/smoke.spec.ts` at
    // 0/7, and it must not be invisible here the way it is to `--candidates`.
    const root = makeTmpDir('adoption')
    try {
      const estate = join(root, 'estate')
      mkdirSync(estate, { recursive: true })
      satellite(estate, 'repo-a', 'biffo.sibling.json', [])
      satellite(estate, 'repo-b', 'biffo.sibling.json', [])
      // Baseline recorded so the ratchet is satisfied: this test is about what
      // gets REPORTED, not about whether an unbaselined path fails (covered
      // separately below).
      const tpl = template(
        root,
        { 'sibling-template': { files: ['src/orphan.ts'] } },
        {
          ...MANIFEST,
          skeletonAdoption: { 'sibling-template:src/orphan.ts': 0 },
        },
      )

      const { out, status } = runAdoption(tpl, estate)
      expect(status, out).toBe(0)
      expect(out).toContain('src/orphan.ts')
      expect(out).toMatch(/src\/orphan\.ts\s+0\/2 hold it/)
      expect(out).toContain('1 skeleton-owned path(s) not held by every applicable repo')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not report a path every applicable repo holds', () => {
    const root = makeTmpDir('adoption')
    try {
      const estate = join(root, 'estate')
      mkdirSync(estate, { recursive: true })
      satellite(estate, 'repo-a', 'biffo.sibling.json', ['src/everyone.ts'])
      satellite(estate, 'repo-b', 'biffo.sibling.json', ['src/everyone.ts'])
      const tpl = template(root, { 'sibling-template': { files: ['src/everyone.ts'] } }, MANIFEST)

      const { out, status } = runAdoption(tpl, estate)
      expect(status, out).toBe(0)
      expect(out).not.toContain('src/everyone.ts')
      expect(out).toContain('0 skeleton-owned path(s) not held by every applicable repo')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('has no threshold: a path held by all but one is reported exactly like one held by none', () => {
    const root = makeTmpDir('adoption')
    try {
      const estate = join(root, 'estate')
      mkdirSync(estate, { recursive: true })
      satellite(estate, 'repo-a', 'biffo.sibling.json', ['src/almost.ts'])
      satellite(estate, 'repo-b', 'biffo.sibling.json', ['src/almost.ts'])
      satellite(estate, 'repo-c', 'biffo.sibling.json', [])
      const tpl = template(
        root,
        { 'sibling-template': { files: ['src/almost.ts'] } },
        {
          ...MANIFEST,
          skeletonAdoption: { 'sibling-template:src/almost.ts': 2 },
        },
      )

      const { out, status } = runAdoption(tpl, estate)
      expect(status, out).toBe(0)
      expect(out).toMatch(/src\/almost\.ts\s+2\/3 hold it {3}lacking: repo-c/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('discriminates a repo skeleton by shipping ci.yml, not a hardcoded name', () => {
    // `_skeletons/registry/` in the real template is plugin-registry content
    // (plugins.json and its schema), never scaffolded into a repo, and ships
    // no ci.yml. A repo mapped to a no-ci skeleton must not surface a gap for
    // it, precisely mirroring the reasoning in
    // cli/src/lib/skeleton-governance-workflows.test.ts (merged #1274).
    const root = makeTmpDir('adoption')
    try {
      const estate = join(root, 'estate')
      mkdirSync(estate, { recursive: true })
      satellite(estate, 'reg-repo', 'registry.marker', ['schema.json'])
      const tpl = template(
        root,
        {
          'sibling-template': { files: [] },
          registry: { files: ['schema.json', 'plugins.json'], ci: false },
        },
        {
          ...MANIFEST,
          skeletonForMarker: {
            'biffo.sibling.json': 'sibling-template',
            'registry.marker': 'registry',
          },
        },
      )

      const { out, status } = runAdoption(tpl, estate)
      expect(status, out).toBe(0)
      // reg-repo lacks plugins.json, which WOULD be a gap if registry were
      // treated as a repo skeleton -- it must not appear because registry
      // ships no ci.yml.
      expect(out).not.toContain('registry --')
      expect(out).not.toContain('plugins.json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores repos with no marker, which were never scaffolded from a skeleton', () => {
    // `skeletonDefault` exists so `filesFromSkeleton` can deliver AGENTS.md to
    // the runner fleets and the design repo. It is NOT a claim they are
    // siblings, and comparing them against a full sibling skeleton would
    // invent gaps in repos that will never hold the paths in question.
    const root = makeTmpDir('adoption')
    try {
      const estate = join(root, 'estate')
      mkdirSync(estate, { recursive: true })
      satellite(estate, 'sibling-a', 'biffo.sibling.json', ['src/shared.ts'])
      satellite(estate, 'sibling-b', 'biffo.sibling.json', ['src/shared.ts'])
      const origin = join(estate, 'runners.git')
      execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', origin])
      const dir = join(estate, 'runners')
      execFileSync('git', ['init', '-q', '-b', 'dev', dir])
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts', 'biffo.sh'), '#!/bin/sh\n')
      commitAll(dir)
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin])
      execFileSync('git', ['-C', dir, 'push', '-q', '-u', 'origin', 'dev'])

      const tpl = template(root, { 'sibling-template': { files: ['src/shared.ts'] } }, MANIFEST)

      const { out, status } = runAdoption(tpl, estate)
      expect(status, out).toBe(0)
      expect(out).toContain('0 skeleton-owned path(s) not held by every applicable repo')
      expect(out).not.toContain('runners')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to report zero gaps when no repo skeleton ships ci.yml', () => {
    // Mirrors --backfill's "refuses to report zero gaps" guard: a zero that
    // means "could not see the input" is the defect class this estate keeps
    // finding, and it must exit non-zero rather than print a clean report.
    const root = makeTmpDir('adoption')
    try {
      const estate = join(root, 'estate')
      mkdirSync(estate, { recursive: true })
      satellite(estate, 'only', 'biffo.sibling.json', ['src/a.ts'])
      const tpl = template(
        root,
        { 'sibling-template': { files: ['src/a.ts'], ci: false } },
        MANIFEST,
      )

      const { out, status } = runAdoption(tpl, estate)
      expect(status, out).not.toBe(0)
      expect(out).toContain('refusing to report zero gaps')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('enumerates the skeleton from the ref, so an untracked artefact is invisible', () => {
    // `find` walks the WORKING TREE. A `.venv/` left in the real
    // `_skeletons/sibling-template/services/api/` by one diagnostic run took
    // this report from 29 rows to **10,994**, burying every real finding under
    // site-packages. Those files ship to nobody -- satellites are measured with
    // `ls-tree` against `origin/<base>` -- so a checkout-side enumeration
    // compares paths that cannot match by construction.
    //
    // Third instance of the class in one day: `auth.ts` read 6 variants from
    // working trees where `origin/dev` had 2, and a branch was judged unpushed
    // from a stale local ref. The fix is structural, not discipline.
    const root = makeTmpDir('adoption-ref')
    try {
      const estate = join(root, 'estate')
      mkdirSync(estate, { recursive: true })
      satellite(estate, 'repo-a', 'biffo.sibling.json', [])
      satellite(estate, 'repo-b', 'biffo.sibling.json', ['src/real.ts'])
      const tpl = template(
        root,
        { 'sibling-template': { files: ['src/real.ts'] } },
        {
          ...MANIFEST,
          skeletonAdoption: { 'sibling-template:src/real.ts': 1 },
        },
      )

      // Untracked, written AFTER the fixture commits — exactly what a
      // gitignored build artefact looks like on a developer's machine.
      const junk = join(tpl, '_skeletons', 'sibling-template', '.venv', 'lib', 'site.py')
      mkdirSync(join(junk, '..'), { recursive: true })
      writeFileSync(junk, 'junk\n')

      const { out, status } = runAdoption(tpl, estate)

      expect(status, out).toBe(0)
      // The tracked partial-adoption gap is still found...
      expect(out).toContain('src/real.ts')
      // ...and the untracked artefact is not reported at all.
      expect(out).not.toContain('.venv')
      expect(out).not.toContain('site.py')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('a holder count below its baseline fails the run', () => {
    // The whole point of the ratchet: residue never blocks, a REGRESSION does.
    const root = makeTmpDir('adoption-regress')
    try {
      const estate = join(root, 'estate')
      mkdirSync(estate, { recursive: true })
      satellite(estate, 'repo-a', 'biffo.sibling.json', ['src/shared.ts'])
      satellite(estate, 'repo-b', 'biffo.sibling.json', [])
      const tpl = template(
        root,
        { 'sibling-template': { files: ['src/shared.ts'] } },
        { ...MANIFEST, skeletonAdoption: { 'sibling-template:src/shared.ts': 2 } },
      )

      const { out, status } = runAdoption(tpl, estate)

      expect(status, out).toBe(1)
      expect(out).toContain('REGRESSED from 2')
      expect(out).toContain('ADOPTION REGRESSED')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('holds the line at the baseline, so pre-existing residue never blocks', () => {
    const root = makeTmpDir('adoption-hold')
    try {
      const estate = join(root, 'estate')
      mkdirSync(estate, { recursive: true })
      satellite(estate, 'repo-a', 'biffo.sibling.json', ['src/shared.ts'])
      satellite(estate, 'repo-b', 'biffo.sibling.json', [])
      const tpl = template(
        root,
        { 'sibling-template': { files: ['src/shared.ts'] } },
        { ...MANIFEST, skeletonAdoption: { 'sibling-template:src/shared.ts': 1 } },
      )

      const { out, status } = runAdoption(tpl, estate)

      expect(status, out).toBe(0)
      expect(out).not.toContain('REGRESSED')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a new unadopted skeleton path with no baseline fails, not passes', () => {
    // Otherwise a skeleton gains a file nobody adopts and nothing notices --
    // the #1271 blind spot reappearing one level up.
    const root = makeTmpDir('adoption-new')
    try {
      const estate = join(root, 'estate')
      mkdirSync(estate, { recursive: true })
      satellite(estate, 'repo-a', 'biffo.sibling.json', [])
      satellite(estate, 'repo-b', 'biffo.sibling.json', [])
      const tpl = template(
        root,
        { 'sibling-template': { files: ['src/brand-new.ts'] } },
        { ...MANIFEST, skeletonAdoption: {} },
      )

      const { out, status } = runAdoption(tpl, estate)

      expect(status, out).toBe(1)
      expect(out).toContain('NEW -- no baseline')
      expect(out).toContain('sibling-template:src/brand-new.ts')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a scaffold-token path is template payload, not an adoption gap', () => {
    // `src/example_plugin/main.py` becomes `src/idea_scout/main.py` in a real
    // plugin, so 0 adoption is CORRECT. Reporting it as a gap invites someone
    // to "fix" it by deleting the file the scaffolder renames, which would
    // break `biffo plugin create` outright.
    const root = makeTmpDir('adoption-payload')
    try {
      const estate = join(root, 'estate')
      mkdirSync(estate, { recursive: true })
      satellite(estate, 'repo-a', 'biffo.sibling.json', [])
      satellite(estate, 'repo-b', 'biffo.sibling.json', [])
      const tpl = template(
        root,
        { 'sibling-template': { files: ['src/example_plugin/main.py'] } },
        {
          ...MANIFEST,
          skeletonAdoption: {},
        },
      )
      writeFileSync(
        join(tpl, '_skeletons', 'sibling-template', '.scaffold-tokens.json'),
        JSON.stringify({ tokens: ['example_plugin'] }),
      )

      const { out, status } = runAdoption(tpl, estate)

      // Not a gap, so no baseline is demanded and the run passes.
      expect(status, out).toBe(0)
      expect(out).toContain('template payload')
      expect(out).not.toContain('NEW -- no baseline')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('does not treat .scaffold-tokens.json as an adoption gap — it is skeleton metadata', () => {
    // Found by the ratchet flagging its OWN arrival, one merge after the file
    // was added: the verification run happened while it was still untracked, so
    // `ls-tree` could not see it. It configures this report rather than
    // shipping to a scaffolded repo, so "no satellite adopted it" is not a gap.
    const root = makeTmpDir('adoption-meta')
    try {
      const estate = join(root, 'estate')
      mkdirSync(estate, { recursive: true })
      satellite(estate, 'repo-a', 'biffo.sibling.json', ['src/shared.ts'])
      satellite(estate, 'repo-b', 'biffo.sibling.json', ['src/shared.ts'])
      const tpl = template(
        root,
        { 'sibling-template': { files: ['src/shared.ts', '.scaffold-tokens.json'] } },
        { ...MANIFEST, skeletonAdoption: {} },
      )

      const { out, status } = runAdoption(tpl, estate)

      // No gaps at all: shared.ts is 2/2 and the metadata file is not counted.
      expect(status, out).toBe(0)
      expect(out).not.toContain('.scaffold-tokens.json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
