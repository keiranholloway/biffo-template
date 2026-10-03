import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  makeTemplateCheckout,
  sharedSyncIn,
  writeSatelliteBridge,
} from '../test-utils/shared-sync-template.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * The reduction gate in `stage_repo` used to treat ANY non-zero exit as a
 * reduction, so a missing `tsx` (exit 127) was reported as WOULD DELETE
 * CONTENT. It must refuse under its own label instead.
 */
const GIT_ID = [
  '-c',
  'user.email=f@example.invalid',
  '-c',
  'user.name=F',
  '-c',
  'commit.gpgsign=false',
]
const git = (dir: string, ...a: string[]) =>
  execFileSync('git', ['-C', dir, ...GIT_ID, ...a], { stdio: 'pipe' })

function setup(bridge: string, tsx?: string) {
  const root = makeTmpDir('reduction-cannot-run')
  const estate = join(root, 'estate')
  mkdirSync(estate, { recursive: true })
  const template = makeTemplateCheckout(estate, {
    files: {
      ...(tsx ? { 'cli/node_modules/.bin/tsx': tsx } : {}),
      'scripts/verify.sh': '#!/bin/sh\n# canonical\nexit 0\n',
      'scripts/biffo.sh': bridge,
      'cli/src/index.ts': '',
    },
  })
  if (tsx) chmodSync(join(template, 'cli/node_modules/.bin/tsx'), 0o755)
  const origin = join(estate, 'tabsii-fixture.git')
  execFileSync('git', ['init', '--bare', '--initial-branch=dev', origin], { stdio: 'pipe' })
  const dir = join(estate, 'tabsii-fixture')
  execFileSync('git', ['clone', origin, dir], { stdio: 'pipe' })
  writeFileSync(join(dir, 'biffo.sibling.json'), '{}\n')
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n')
  writeSatelliteBridge(dir)
  writeFileSync(join(dir, 'scripts', 'verify.sh'), '#!/bin/sh\nexit 0\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'fixture')
  git(dir, 'push', '-q', '-u', 'origin', 'dev')
  git(dir, 'remote', 'set-head', 'origin', 'dev')

  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'gh'),
    '#!/bin/sh\n[ "$1 $2" = "repo view" ] && echo dev && exit 0\nexit 1\n',
  )
  chmodSync(join(bin, 'gh'), 0o755)
  const res = spawnSync('sh', [sharedSyncIn(template), '--now', '--estate', estate], {
    encoding: 'utf8',
    cwd: template,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SHARED_SYNC_WT_LOG: join(root, 'wt.log'),
    },
  })
  return { out: (res.stdout ?? '') + (res.stderr ?? ''), code: res.status }
}

// Mirrors the real bridge's tail: exec of the template's own tsx.
const MISSING_TSX = '#!/bin/sh\nexec "$PWD/cli/node_modules/.bin/tsx" cli/src/index.ts "$@"\n'

describe('shared-sync reduction check that could not run', () => {
  it('reports a missing tsx as such, not as WOULD DELETE CONTENT', () => {
    const { out, code } = setup(MISSING_TSX)
    expect(out).toContain('REDUCTION CHECK COULD NOT RUN')
    expect(out).toContain('tsx')
    expect(out).not.toContain('WOULD DELETE CONTENT')
    expect(code).not.toBe(0)
  })

  it('still reports a real reduction (tsx runs, exits 1) as WOULD DELETE CONTENT', () => {
    const { out } = setup(
      '#!/bin/sh\nexec "$PWD/cli/node_modules/.bin/tsx" cli/src/index.ts "$@"\n',
      '#!/bin/sh\nexit 1\n',
    )
    expect(out).toContain('WOULD DELETE CONTENT')
    expect(out).not.toContain('COULD NOT RUN')
  })
})
