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
 * Deliberately narrow on EXISTENCE. An earlier draft checked *every* `../`
 * reference for existence and was wrong: `../lambda.zip` and
 * `../plugin-host.zip` are build artifacts created at runtime and legitimately
 * absent from the checkout. Only an *executed script* must exist before its step
 * runs, so only that is asserted below — a guard that cries wolf on correct code
 * gets deleted, and then catches nothing.
 *
 * ## What that narrowing cost, and the second assertion it produced
 *
 * Excusing build artifacts from the EXISTENCE check silently excused them from
 * every check, and a bug moved straight into the gap: the core API step wrote
 * its zip to the step's own directory and then read it back one level higher.
 *
 *     zipped=$(cd package && zip -qr ../lambda.zip .)   # -> <step>/lambda.zip
 *     aws lambda update-function-code --zip-file fileb://../lambda.zip
 *                                                        # -> <repo>/lambda.zip
 *
 * It failed with `Unable to load paramfile fileb://../lambda.zip` — after a
 * successful build, after the version was baked, and after two *other* bugs in
 * the same step had been fixed, each of which had been masking it. The three
 * sibling zips in the same job (pr-signer, plugin-host, per-plugin) all read
 * theirs back bare and were correct; only this one carried the extra `../`.
 *
 * A runtime artifact cannot be checked for existence, but it CAN be checked for
 * **agreement**: whatever a step's `zip` writes is what its `fileb://` must
 * read. That needs no filesystem and no knowledge of what the artifact contains.
 *
 * Interpolated names stop being a problem under this rule rather than needing an
 * exemption — every one of these is `cd <dir> && zip ../<name>.zip`, and
 * `<dir>/../<name>.zip` normalises to `<name>.zip` whatever `<dir>` expands to.
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

/**
 * Artifacts a step's `zip` writes, resolved against the step's own directory.
 *
 * Every call in these workflows is `cd <dir> && zip [flags] <dir-relative>.zip`,
 * so the output is `normalize(<dir>/<arg>)`. The `cd` scopes the argument the
 * same way whether it is command-substituted (`$( … )`), subshelled (`( … )`)
 * or balanced by a later `cd ..` — all three shapes appear here.
 */
function zipOutputs(yaml: string): { path: string; line: number }[] {
  const found: { path: string; line: number }[] = []
  yaml.split('\n').forEach((raw, line) => {
    if (/^\s*#/.test(raw)) return
    const m = /cd\s+"?([^"'&|;]+?)"?\s*&&\s*zip\s+[^&|;]*?"?([^\s"';&|]+\.zip)"?/.exec(raw)
    if (m) found.push({ path: normalize(join(m[1], m[2])), line })
  })
  return found
}

/** Every `fileb://` the workflow reads back, resolved against its step. */
function filebReads(yaml: string): { path: string; line: number }[] {
  const found: { path: string; line: number }[] = []
  yaml.split('\n').forEach((raw, line) => {
    if (/^\s*#/.test(raw)) return
    const m = /fileb:\/\/([^\s"'\\]+)/.exec(raw)
    if (m) found.push({ path: normalize(m[1]), line })
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

  it.each(WORKFLOWS)('%s reads back the build artifacts it writes', (workflow) => {
    const path = join(repoRoot, '.github/workflows', workflow)
    if (!existsSync(path)) return
    const yaml = readFileSync(path, 'utf8')
    const written = new Set(zipOutputs(yaml).map((z) => z.path))
    const reads = filebReads(yaml)
    if (reads.length === 0) return
    // Guard the guard: if the extractors stop matching, an empty set must not
    // read as agreement.
    expect(written.size).toBeGreaterThan(0)

    const broken = reads
      .filter(({ path: p }) => !written.has(p))
      .map(
        ({ path: p, line }) =>
          `${workflow}:${line + 1}  fileb://${p}  is never written by a zip in this workflow (written: ${[...written].join(', ')})`,
      )
    expect(broken).toEqual([])
  })
})
