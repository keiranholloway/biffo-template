import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  anchorToOrigin,
  makeTemplateCheckout,
  sharedSyncIn,
} from '../test-utils/shared-sync-template.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `tabsii-data-model-design` is out of shared-sync and every upgrade path
 * (owner decision, 2026-10-10). It is a design-only repo for the base data
 * model: no app, no deploy, no CI. It holds the shared bridge from an earlier
 * round, so without its `excludes` entry `applies()` would select it through
 * the `scripts/biffo.sh` clause and the scheduled round would keep opening
 * `chore(shared): sync template-shared files` PRs there -- the last one,
 * tabsii-com/tabsii-data-model-design#55, sat CLEAN and unmerged for four days
 * and held three drift-report issues waiting on it.
 *
 * Driven against the REAL manifest's `excludes` rather than a copy, so dropping
 * the entry from `shared-files.json` fails this test.
 */
const realManifest = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'shared-files.json'), 'utf8'),
) as { excludes: Record<string, string> }

const GIT_ID = ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture']

/** A marker-less satellite on `dev` that holds the shared bridge, anchored to its own origin. */
function satellite(estate: string, name: string): void {
  const dir = join(estate, name)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const bridge = join(dir, 'scripts', 'biffo.sh')
  writeFileSync(bridge, '#!/bin/sh\nexit 0\n')
  chmodSync(bridge, 0o755)
  execFileSync('git', ['init', '-q', '-b', 'dev', dir], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, ...GIT_ID, 'add', '-A'], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, ...GIT_ID, 'commit', '-qm', 'chore: fixture satellite'], {
    stdio: 'pipe',
  })
  anchorToOrigin(dir)
}

describe('shared-sync excludes tabsii-data-model-design (owner decision 2026-10-10)', () => {
  it('declares the exclusion with a reason that takes it out of every upgrade path', () => {
    const reason = realManifest.excludes['tabsii-data-model-design']
    expect(reason, 'tabsii-data-model-design must stay in excludes').toBeTruthy()
    expect(reason).toMatch(/every upgrade path/)
  })

  it('never surveys it, while a marker-less satellite beside it still is', () => {
    const root = makeTmpDir('dmdexcl')
    const estate = join(root, 'estate')
    const template = makeTemplateCheckout(estate, {
      manifest: { excludes: realManifest.excludes },
    })
    satellite(estate, 'tabsii-data-model-design')
    satellite(estate, 'tabsii-map')

    const result = spawnSync('sh', [sharedSyncIn(template), '--check', '--estate', estate], {
      encoding: 'utf8',
    })
    const output = `${result.stdout}${result.stderr}`
    const [declared, survey = ''] = output.split('Every count below is over the REMAINING repos')

    // Named, with its reason, in the declared-exclusions block -- never silent.
    expect(declared).toContain('tabsii-data-model-design: out of shared-sync')
    // The control satellite proves the walk ran and selected marker-less repos...
    expect(survey).toContain('tabsii-map')
    // ...and the excluded repo is not among them.
    expect(survey).not.toContain('tabsii-data-model-design')
  })
})
