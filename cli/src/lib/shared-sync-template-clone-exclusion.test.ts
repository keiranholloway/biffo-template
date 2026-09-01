import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTemplateCheckout, sharedSyncIn } from '../test-utils/shared-sync-template.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * biffo-template#1841.
 *
 * `repo_dir()` resolves `git rev-parse --git-common-dir`, which is an
 * identity for one WORKING TREE -- it recognises a `git worktree add` of the
 * real checkout, because a worktree shares its primary's `.git`. It is not an
 * identity for "any clone of this remote": an independent, second
 * `git clone` of the template's own remote sitting anywhere directly under
 * `$ESTATE` gets its OWN `.git`, so `repo_dir()` returns a different path and
 * `[ "$(repo_dir "$d")" = "$TEMPLATE_REPO" ]` never fires for it.
 *
 * `applies()` then finds the usual `scripts/biffo.sh` bridge (it's a clone of
 * the template, so it has one) and accepts the stray clone as an applicable
 * satellite. Because shared-sync is fail-closed on a shipping round, a stray
 * clone failing its own gate aborts distribution to every REAL satellite --
 * observed for real at `~/code/tmp-verify-1664`, silently withholding shared
 * files from every satellite for five-plus days (2026-08-26 through
 * 2026-08-31).
 *
 * This is the same class as biffo-template#1785 (a stray WORKTREE), already
 * fixed for that case -- the independent-clone case is a separate gap in the
 * same exclusion, closed here by ALSO excluding a directory whose resolved
 * `origin` remote matches the template's own, alongside the existing
 * `git-common-dir` check.
 */
function fixture(): { estate: string; template: string; strayClone: string } {
  const root = makeTmpDir('tplclone')
  const estate = join(root, 'estate')
  // Lives at estate/template, anchored to its own bare origin at
  // estate/template-origin.git -- a BARE repo, so the estate walk's
  // `[ -e "$d/.git" ]` test skips it and it is never mistaken for a satellite.
  const template = makeTemplateCheckout(estate)

  // An INDEPENDENT second clone of the template's own remote, sitting
  // directly under $ESTATE next to the template. Deliberately `git clone`,
  // not `git worktree add` -- it gets its own `.git` and therefore its own
  // `git rev-parse --git-common-dir`, which is exactly the gap #1841 reports.
  const originUrl = execFileSync('git', ['-C', template, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
  }).trim()
  const strayClone = join(estate, 'stray-clone')
  execFileSync('git', ['clone', '-q', originUrl, strayClone], { stdio: 'pipe' })

  return { estate, template, strayClone }
}

describe('shared-sync excludes an independent clone of the template remote (#1841)', () => {
  it('never surveys a stray clone of its own remote', () => {
    const { estate, template } = fixture()
    const result = spawnSync('sh', [sharedSyncIn(template), '--check', '--estate', estate], {
      encoding: 'utf8',
    })
    const output = `${result.stdout}${result.stderr}`

    // Pre-fix, the stray clone is picked up like a real satellite and reported
    // `current` (it is a byte-identical fresh clone of the template's own
    // shared-file set) -- proving `applies()` accepted it. Post-fix it must
    // never appear in the survey at all: excluded before `considered` even
    // counts it, the same as the template directory itself.
    expect(output).not.toContain('stray-clone')
  })
})
