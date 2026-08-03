import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `--backfill` answers the question `--candidates` structurally cannot (#1109):
 * **what does a skeleton ship that some of its repos have and others lack?**
 *
 * Improving a skeleton helps only repos scaffolded afterwards. Existing ones
 * keep whatever it said on the day they were born, and nothing reported the
 * difference — four frontend helpers sat in the newest sibling and in none of
 * the four older ones, and nobody had decided that.
 *
 * `--candidates` cannot see it: it requires a path in >=5 repos, and a file the
 * skeleton gained last month lives in the one repo scaffolded since.
 *
 * These tests run the real script against a **fixture template and estate**
 * rather than this repo's own skeletons, so they assert the filtering rules
 * themselves rather than today's estate contents — which change weekly and
 * would make this a change-detector.
 */
const realScript = join(import.meta.dirname, '..', '..', '..', 'scripts', 'shared-sync.sh')

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
  // Every in-scope repo needs the gate for `applies()` to select it.
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'verify.sh'), '#!/bin/sh\n')
  for (const rel of files) {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(join(dir, rel), `${rel}\n`)
  }
  commitAll(dir)
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin])
  execFileSync('git', ['-C', dir, 'push', '-q', '-u', 'origin', 'dev'])
}

/**
 * A template checkout carrying the real script, a manifest, and one skeleton
 * holding `skeletonFiles`.
 */
function template(root: string, skeletonFiles: string[], manifest: object): string {
  const dir = join(root, 'template')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'dev', dir])
  cpSync(realScript, join(dir, 'scripts', 'shared-sync.sh'))
  writeFileSync(join(dir, 'shared-files.json'), JSON.stringify(manifest, null, 2))
  for (const rel of skeletonFiles) {
    const full = join(dir, '_skeletons', 'sibling-template', rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, `${rel}\n`)
  }
  commitAll(dir)
  return dir
}

const MANIFEST = {
  files: ['scripts/verify.sh'],
  filesFromSkeleton: {},
  skeletonForMarker: { 'biffo.sibling.json': 'sibling-template' },
  skeletonDefault: 'sibling-template',
}

function runBackfill(templateDir: string, estate: string): { out: string; status: number } {
  try {
    const out = execFileSync(
      'sh',
      [join(templateDir, 'scripts', 'shared-sync.sh'), '--backfill', '--estate', estate],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return { out, status: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, status: e.status ?? -1 }
  }
}

describe('shared-sync.sh --backfill', () => {
  it('reports only paths some repos have and others lack', () => {
    const root = makeTmpDir('backfill')
    try {
      const estate = join(root, 'estate')
      mkdirSync(estate, { recursive: true })
      // `partial` is in one repo and not the other -- the gap.
      // `everyone` is in both -- adopted, nothing to say.
      // `nobody` is in the skeleton and neither repo -- scaffolding they were
      // meant to consume or rename, not a gap.
      satellite(estate, 'newer', 'biffo.sibling.json', ['src/partial.ts', 'src/everyone.ts'])
      satellite(estate, 'older', 'biffo.sibling.json', ['src/everyone.ts'])
      const tpl = template(root, ['src/partial.ts', 'src/everyone.ts', 'src/nobody.ts'], MANIFEST)

      const { out, status } = runBackfill(tpl, estate)
      expect(status, out).toBe(0)
      expect(out).toContain('src/partial.ts')
      expect(out).not.toContain('src/everyone.ts')
      expect(out).not.toContain('src/nobody.ts')
      expect(out).toContain('1 backfill gap(s) total')
      // Names the repos that lack it, or the reader has to go and find out.
      expect(out).toMatch(/src\/partial\.ts.*older/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips paths the manifest already governs', () => {
    // A listed path has a channel and `--check` reports on it. Repeating it
    // here would be a second voice on a question already answered.
    const root = makeTmpDir('backfill')
    try {
      const estate = join(root, 'estate')
      mkdirSync(estate, { recursive: true })
      satellite(estate, 'newer', 'biffo.sibling.json', ['src/listed.ts'])
      satellite(estate, 'older', 'biffo.sibling.json', [])
      const tpl = template(root, ['src/listed.ts'], {
        ...MANIFEST,
        files: ['scripts/verify.sh', 'src/listed.ts'],
      })

      const { out, status } = runBackfill(tpl, estate)
      expect(status, out).toBe(0)
      expect(out).toContain('0 backfill gap(s) total')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores repos with no marker, which were never scaffolded from a skeleton', () => {
    // `skeletonDefault` exists so filesFromSkeleton can deliver AGENTS.md to
    // the runner fleets and the design repo. It is NOT a claim they are
    // siblings. Comparing them against a full sibling skeleton reported 39
    // fictional gaps against 20 real ones -- `services/api/*` "missing" from
    // repos that will never hold a FastAPI service.
    const root = makeTmpDir('backfill')
    try {
      const estate = join(root, 'estate')
      mkdirSync(estate, { recursive: true })
      satellite(estate, 'sibling-a', 'biffo.sibling.json', ['src/shared.ts'])
      satellite(estate, 'sibling-b', 'biffo.sibling.json', ['src/shared.ts'])
      // In scope via the verify.sh clause, but carries no marker.
      const origin = join(estate, 'runners.git')
      execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', origin])
      const dir = join(estate, 'runners')
      execFileSync('git', ['init', '-q', '-b', 'dev', dir])
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts', 'verify.sh'), '#!/bin/sh\n')
      commitAll(dir)
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin])
      execFileSync('git', ['-C', dir, 'push', '-q', '-u', 'origin', 'dev'])

      const tpl = template(root, ['src/shared.ts'], MANIFEST)

      const { out, status } = runBackfill(tpl, estate)
      expect(status, out).toBe(0)
      // Both markered repos hold it; the marker-less one must not invent a gap.
      expect(out).toContain('0 backfill gap(s) total')
      expect(out).not.toContain('runners')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to report zero gaps when it could not read the skeletons', () => {
    // The first cut used `$TEMPLATE_REPO` -- repo_dir()'s output, i.e. the .git
    // COMMON DIR -- so `<...>/.git/_skeletons/*/` matched nothing and the run
    // printed a confident `0 backfill gap(s)`. A zero meaning "could not see
    // the input" is the defect this estate keeps finding; it must exit non-zero.
    const root = makeTmpDir('backfill')
    try {
      const estate = join(root, 'estate')
      mkdirSync(estate, { recursive: true })
      satellite(estate, 'only', 'biffo.sibling.json', ['src/a.ts'])
      const tpl = template(root, ['src/a.ts'], MANIFEST)
      rmSync(join(tpl, '_skeletons'), { recursive: true, force: true })

      const { out, status } = runBackfill(tpl, estate)
      expect(status, out).not.toBe(0)
      expect(out).toContain('refusing to report zero gaps')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
