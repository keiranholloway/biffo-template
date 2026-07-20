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

  it('only dispatches when a tag was actually created or moved', () => {
    // steps.sync.outputs.tag is unset when the tag already stood for this tree.
    // Without this condition every push to the default branch would release.
    expect(coreTag).toMatch(/if:\s*steps\.sync\.outputs\.tag\s*!=\s*''/)
  })

  it('publish-cli.yml still accepts a manual dispatch as the recovery path', () => {
    expect(publishCli).toContain('workflow_dispatch:')
  })
})
