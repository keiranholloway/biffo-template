/**
 * `resolve-core-version.sh` must work regardless of the caller's working
 * directory.
 *
 * `deploy-app.yml` invokes it from `working-directory: api-service` — the
 * directory `download-artifact` unpacks the built API into, one level below the
 * checkout root. The script tested `[ -f biffo.core.json ]` against the CWD, so
 * from there it saw neither the instance's `biffo.core.json` nor the template's
 * git tags, printed "cannot determine a core version" and failed the deploy.
 *
 * The message was accurate and the diagnosis it suggested (missing `fetch-tags`)
 * was wrong for this case, which is what made it expensive: the version was
 * present the whole time, one directory up.
 *
 * This is asserted here, in the repo that owns the script, because **this repo
 * never runs `deploy-app.yml`** — biffo-template is non-deployable, it publishes
 * to npm. Nothing upstream exercises the failing call shape, so without a test
 * the next regression is again found by an instance's failed deploy.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// cli/src/lib/ -> cli/src/ -> cli/ -> repo root
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const script = join(repoRoot, 'scripts/resolve-core-version.sh')

let workdir: string

beforeEach(() => {
  // A minimal INSTANCE: biffo.core.json at the root, the script under scripts/,
  // and the artifact directory deploy-app.yml actually runs from.
  workdir = mkdtempSync(join(tmpdir(), 'corever-'))
  mkdirSync(join(workdir, 'scripts'), { recursive: true })
  mkdirSync(join(workdir, 'api-service'), { recursive: true })
  writeFileSync(join(workdir, 'biffo.core.json'), JSON.stringify({ version: '9.9.9' }))
  copyFileSync(script, join(workdir, 'scripts/resolve-core-version.sh'))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

const run = (cwd: string, scriptPath: string): string =>
  execFileSync('sh', [scriptPath, '--quiet'], { cwd, encoding: 'utf8' }).trim()

describe('resolve-core-version.sh is independent of the caller working directory', () => {
  it('resolves the instance version when run from the repo root', () => {
    expect(run(workdir, 'scripts/resolve-core-version.sh')).toBe('9.9.9')
  })

  it('resolves it from api-service/, the way deploy-app.yml calls it', () => {
    // The exact shape that failed in CI: cwd is the artifact dir, and the
    // script is reached by a relative path one level up.
    expect(run(join(workdir, 'api-service'), '../scripts/resolve-core-version.sh')).toBe('9.9.9')
  })

  it('resolves it when invoked by absolute path from an unrelated directory', () => {
    expect(run(tmpdir(), join(workdir, 'scripts/resolve-core-version.sh'))).toBe('9.9.9')
  })
})
