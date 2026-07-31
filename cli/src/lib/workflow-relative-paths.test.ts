/**
 * A workflow step that *executes* a script by relative path must point at a
 * script that actually exists, given that step's `working-directory`.
 *
 * This exists because `deploy-app.yml` shipped
 * `sh ../../scripts/resolve-core-version.sh` from a step whose
 * `working-directory: api-service` is ONE level below the repo root — so the
 * path pointed above the checkout and the step died with
 * `No such file or directory`, exit 127, after a successful build. The same
 * step three lines earlier already used `../packages/cognito-auth` correctly,
 * under a comment explaining that `../` is right "because this step runs in the
 * api-service artifact dir and the full repo checkout is its parent".
 *
 * Why it survived review: **this repo never runs `deploy-app.yml`.**
 * biffo-template is non-deployable — it publishes to npm. The workflow is
 * authored here and exercised nowhere here, so the first instance to take it
 * via `biffo core upgrade` is where it breaks. A guard that runs in the repo
 * that OWNS the file is the only thing that catches this before distribution.
 *
 * Deliberately narrow. An earlier draft checked *every* `../` reference and was
 * wrong: `../lambda.zip` and `../plugin-host.zip` are build artifacts created
 * at runtime and legitimately absent from the checkout, and interpolated names
 * cannot be resolved statically at all. Only an *executed script* must exist
 * before the step runs, so only that is asserted here — a guard that cries wolf
 * on correct code gets deleted, and then catches nothing.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// cli/src/lib/ -> cli/src/ -> cli/ -> repo root
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** The `working-directory:` in force at each line, by line index. */
function workingDirByLine(yaml: string): string[] {
  const out: string[] = []
  let current = ''
  let stepIndent = -1
  for (const line of yaml.split('\n')) {
    const step = /^(\s*)- (name|uses|run|id):/.exec(line)
    if (step) {
      stepIndent = step[1].length
      current = ''
    }
    const wd = /^(\s*)working-directory:\s*(\S+)\s*$/.exec(line)
    if (wd && wd[1].length > stepIndent) current = wd[2]
    out.push(current)
  }
  return out
}

/** `sh ../x.sh` / `bash ../x.sh` — scripts the step shells out to. */
function executedScripts(yaml: string): { path: string; line: number }[] {
  const found: { path: string; line: number }[] = []
  yaml.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return
    for (const m of line.matchAll(/\b(?:sh|bash)\s+(\.\.?\/[A-Za-z0-9._/-]+\.sh)\b/g)) {
      found.push({ path: m[1], line: i })
    }
  })
  return found
}

const WORKFLOWS = ['deploy-app.yml', 'deploy-infra.yml', 'ci.yml']

describe('workflow scripts resolve against their working-directory', () => {
  it('the extractor finds the invocations it is meant to check', () => {
    // Guard the guard. If this ever returns nothing, every assertion below
    // passes vacuously and the file is decoration rather than coverage.
    const yaml = readFileSync(join(repoRoot, '.github/workflows/deploy-app.yml'), 'utf8')
    expect(executedScripts(yaml).length).toBeGreaterThan(0)
  })

  it.each(WORKFLOWS)('%s executes only scripts that exist', (workflow) => {
    const path = join(repoRoot, '.github/workflows', workflow)
    if (!existsSync(path)) return
    const yaml = readFileSync(path, 'utf8')
    const wds = workingDirByLine(yaml)

    const broken = executedScripts(yaml)
      .map(({ path: script, line }) => {
        const wd = wds[line] ?? ''
        const resolved = normalize(join(repoRoot, wd, script))
        if (!resolved.startsWith(repoRoot)) {
          return `${workflow}:${line + 1}  ${script}  escapes the checkout (working-directory=${wd || '.'})`
        }
        if (!existsSync(resolved)) {
          return `${workflow}:${line + 1}  ${script}  does not exist (working-directory=${wd || '.'})`
        }
        return null
      })
      .filter((x): x is string => x !== null)

    expect(broken).toEqual([])
  })
})
