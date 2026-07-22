import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Guard: the CLI release must actually be triggered.
 *
 * `core-tag.yml` pushes `core-v*` using the job's GITHUB_TOKEN, and GitHub does
 * not trigger workflows from GITHUB_TOKEN-created events — it suppresses that to
 * stop workflows recursing. So `publish-cli.yml`'s `on: push: tags: [core-v*]`
 * never fired, and every release was a manual dispatch nobody was told to make.
 * The failure mode is silence: a version ships, no package follows, nothing
 * reports a problem.
 *
 * The fix is an explicit dispatch from the tagging job. These assertions hold
 * the three parts that make it work — remove any one and releases go quiet again.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const coreTag = readFileSync(resolve(repoRoot, '.github/workflows/core-tag.yml'), 'utf8')
const publishCli = readFileSync(resolve(repoRoot, '.github/workflows/publish-cli.yml'), 'utf8')

describe('CLI release dispatch', () => {
  it('core-tag.yml can dispatch workflows', () => {
    // Without this permission the dispatch 403s at run time, not at lint time.
    //
    // Anchored to a real YAML line. A looser /actions:\s*write/ was satisfied by
    // the prose in this workflow's own comments, so deleting the permission left
    // the test green — passing for the wrong reason, which is worse than absent.
    expect(coreTag).toMatch(/^\s+actions:\s+write\s*$/m)
  })

  it('core-tag.yml dispatches publish-cli.yml', () => {
    expect(coreTag).toContain('gh workflow run publish-cli.yml')
  })

  it('dispatches against the tag, not the branch', () => {
    // Publishing resolves the version from the tag; dispatching on main would
    // publish whatever main happens to be, which is not what was tagged.
    expect(coreTag).toMatch(/--ref "\$TAG"/)
  })

  it('only dispatches when a tag was actually created', () => {
    // steps.sync.outputs.tag is unset when the tag already stood for this tree.
    // Without this condition every push to the default branch would release.
    expect(coreTag).toMatch(/if:\s*steps\.sync\.outputs\.tag\s*!=\s*''/)
  })

  it('publish-cli.yml still accepts a manual dispatch as the recovery path', () => {
    expect(publishCli).toContain('workflow_dispatch:')
  })
})

/**
 * Guard: a failed publish must say what failed and what to do (#342).
 *
 * The step was a bare `npm publish`. When the release race put a second commit
 * on the same version, npm's 403 failed the job and said so in a log nobody
 * opened — main held one tree and npm another as 0.41.9, and nothing surfaced
 * it. These assertions hold the parts that make the failure legible; the
 * classification itself is tested in npm-publish.test.ts.
 */
describe('publish failure reporting', () => {
  /**
   * The Publish step's shell **with its comment lines removed**.
   *
   * Not fussiness. Twice while writing these guards, an assertion matched the
   * step's own prose rather than its code and stayed green after the code was
   * deleted — the same failure the `actions: write` test above records. This
   * step explains PIPESTATUS, pipefail and gitHead by name in its comments, so
   * every substring worth asserting also appears in English right next to it.
   * Stripping the comments removes the trap for every assertion below at once,
   * rather than requiring each to be individually paranoid.
   */
  const publishStep = (publishCli.split('- name: Publish')[1] ?? '')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

  it('captures npm’s output instead of letting it scroll past', () => {
    expect(publishStep).toContain('tee "$log"')
  })

  it('reads npm’s exit status through the pipe, not tee’s', () => {
    // AGENTS.md §4: `cmd | tee` reports tee's status. Taking it at face value
    // here would turn every publish failure — including the already-published
    // one — into a green run, which is strictly worse than what #342 had.
    //
    // Anchored to the assignment as well as comment-stripped: verified by
    // changing the code to `status=$?`, which the plain substring did not catch.
    expect(publishStep).toMatch(/^\s*status=\$\{PIPESTATUS\[0\]\}\s*$/m)
  })

  it('does not enable pipefail or -e around the capture', () => {
    // The default shell is `bash -e`. Either would abort on the failure this
    // step exists to explain, before it explains anything.
    //
    // Anchored to a real `set` line, not the substring: this step's own comment
    // says the word "pipefail" while explaining why it is absent, and a loose
    // match on it passes for the wrong reason — the same way a loose
    // /actions:\s*write/ above was satisfied by prose rather than permission.
    const capture = publishStep.split('if [ "$status" -eq 0 ]')[0] ?? ''
    expect(capture).not.toMatch(/^\s*set -[eu]*o pipefail\s*$/m)
    expect(capture).toMatch(/^\s*set \+e\s*$/m)
  })

  it('hands the failure to the reporter rather than classifying it in YAML', () => {
    expect(publishStep).toContain('report:publish-failure')
  })

  it('asks the registry what it actually holds, so the report can be specific', () => {
    // gitHead is what turns "someone must decide which is right" into a verdict.
    expect(publishStep).toContain('gitHead')
    expect(publishStep).toContain('PUBLISH_REGISTRY_GIT_HEAD=')
  })

  it('never lets that lookup mask the real failure', () => {
    // An npm outage while diagnosing an npm outage must not become the error.
    expect(publishStep).toMatch(/npm view .*gitHead 2>\/dev\/null \|\| true/)
  })

  it('reports the commit that was built, not the event’s SHA', () => {
    // They differ whenever the `tag` input names something other than the
    // dispatch ref, and comparing the wrong one against gitHead would invent a
    // disagreement or hide a real one.
    expect(publishCli).toContain('commit=$(git rev-parse HEAD)')
    expect(publishStep).toContain('PUBLISH_COMMIT="$COMMIT"')
    expect(publishStep).not.toContain('PUBLISH_COMMIT="$GITHUB_SHA"')
  })

  it('says so in the run summary when the publish succeeds', () => {
    // The other half of legibility: a release that happened should be visible
    // without reading the log either.
    expect(publishStep).toContain('::notice::Published')
    expect(publishStep).toContain('GITHUB_STEP_SUMMARY')
  })
})
