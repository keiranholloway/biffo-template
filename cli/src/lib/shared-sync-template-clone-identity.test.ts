import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTemplateCheckout, sharedSyncIn } from '../test-utils/shared-sync-template.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * biffo-template#1843, the residual gap in #1841/#1842's own fix.
 *
 * `is_template_dir()` closed the independent-clone gap by matching on
 * `repo_slug()` (the resolved `owner/repo` of a directory's `origin` remote)
 * *in addition to* `git-common-dir`. That comparison was a bare
 * case-sensitive `[ = ]`, and it only short-circuited when the TEMPLATE side
 * had no `origin` -- never when the CANDIDATE side didn't. A fleet
 * prosecutor reproduced two real shapes that fell straight through it, live
 * against #1842's own diff, both reproducing #1841's exact original symptom
 * one layer down: accepted by `applies()` as an ordinary satellite, then
 * failing to fetch, aborting the whole fail-closed shipping round.
 *
 * Both fixtures below build a real, otherwise-legitimate clone of the
 * template's own remote -- the same shape `shared-sync-template-clone-
 * exclusion.test.ts` already proves gets excluded -- and then mutate its
 * remote configuration into one of the two shapes the case-sensitive,
 * origin-only comparison missed.
 */
function fixture(): { estate: string; template: string; originUrl: string } {
  const root = makeTmpDir('tplclone-identity')
  const estate = join(root, 'estate')
  const template = makeTemplateCheckout(estate)
  const originUrl = execFileSync('git', ['-C', template, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
  }).trim()
  return { estate, template, originUrl }
}

function runCheck(template: string, estate: string): string {
  const result = spawnSync('sh', [sharedSyncIn(template), '--check', '--estate', estate], {
    encoding: 'utf8',
  })
  return `${result.stdout}${result.stderr}`
}

describe('shared-sync excludes a template clone by identity, case- and remote-name-insensitively (#1843)', () => {
  it('excludes a clone whose origin URL differs only in case from the template remote', () => {
    const { estate, template, originUrl } = fixture()

    // GitHub repo slugs are case-insensitive: `KeiranHolloway/Biffo-Template`
    // and `keiranholloway/biffo-template` name the same repository. Model
    // that here by giving the stray clone the SAME remote, upper-cased --
    // still a clone of the template, just referenced with different case.
    const strayClone = join(estate, 'stray-case-clone')
    execFileSync('git', ['clone', '-q', originUrl, strayClone], { stdio: 'pipe' })
    execFileSync(
      'git',
      ['-C', strayClone, 'remote', 'set-url', 'origin', originUrl.toUpperCase()],
      { stdio: 'pipe' },
    )

    const output = runCheck(template, estate)

    // Pre-fix, the case-sensitive `[ = ]` never matches the upper-cased
    // remote against the template's lower-case one, so the stray clone is
    // NOT excluded: it reaches applies() as an ordinary satellite, then
    // `git fetch origin` fails against the now bogus upper-cased path
    // (case-sensitive filesystem), and it is reported as unfetchable --
    // reproducing #1841's original fail-closed abort. Post-fix it must never
    // appear in the survey at all, the same as the template directory
    // itself.
    expect(output).not.toContain('stray-case-clone')
  })

  it('excludes a clone whose origin remote has been renamed away from "origin"', () => {
    const { estate, template, originUrl } = fixture()

    // The plausible real-world shape #1841's own incident was: an abandoned
    // scratch/verification clone, remote renamed the way a `git remote
    // rename origin upstream` habit or a manual `git remote add upstream`
    // cleanup would leave it. It is still, in every way that matters, a
    // clone of the template -- just not one with a remote literally named
    // `origin`.
    const strayClone = join(estate, 'stray-renamed-clone')
    execFileSync('git', ['clone', '-q', originUrl, strayClone], { stdio: 'pipe' })
    execFileSync('git', ['-C', strayClone, 'remote', 'rename', 'origin', 'upstream'], {
      stdio: 'pipe',
    })

    const output = runCheck(template, estate)

    // Pre-fix, `repo_slug()` only ever asks for a remote named `origin`;
    // with none present it returns empty, which compares unequal to the
    // template's (non-empty) slug and reads as "not the template" rather
    // than "cannot tell". The clone then reaches applies(), and
    // `git fetch origin --prune` fails outright (no remote by that name) --
    // again reproducing #1841's fail-closed abort. Post-fix, checking every
    // remote the candidate carries finds `upstream` pointing at the
    // template's own URL and excludes it before the survey ever touches it.
    expect(output).not.toContain('stray-renamed-clone')
  })
})
