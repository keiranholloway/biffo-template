/**
 * `actions/upload-artifact@v5` excludes any dot-prefixed path segment by
 * default (`include-hidden-files` defaults to `false`) -- and critically,
 * that exclusion applies to the SEARCH-PATH ROOT itself, not just nested
 * descendants. `deploy-infra.yml`'s `tfbuild-<env>` steps upload
 * `infra/environments/<env>/.build/` -- a dot-DIRECTORY at the artefact
 * root -- so without this flag the step silently uploaded NOTHING even when
 * `.build/` held real `archive_file` zips: `filesToUpload.length === 0`
 * combined with `if-no-files-found: ignore` logs "No files were found" and
 * exits success, indistinguishable from the legitimate "no archive_file in
 * this env" case. `apply-<env>`'s paired `download-artifact` then found no
 * artifact to restore and `terraform apply` failed with
 * `open ./.build/<name>.zip: no such file or directory` -- the exact
 * production incident (run 32265569287, biffo-template#1774) this fix (#1663)
 * exists to prevent.
 *
 * The same class was already hit and fixed once for a NESTED hidden dir
 * (`apps/portal/out/.well-known/` in `deploy-app.yml`, #1159) -- proof this
 * is a recurring shape in these workflows, not a one-off. This guard is
 * written generically (enumerate every `upload-artifact` step whose `path`
 * targets a dot-prefixed final segment) rather than naming `tfbuild-dev`/
 * `tfbuild-staging`/`tfbuild-prod` literally, so a future upload of another
 * hidden directory in either workflow is caught the same way, not just a
 * repeat of these three names.
 *
 * Confirmed directly against the real `actions/upload-artifact@v5` bundled
 * source (`dist/upload/index.js`, fetched from the `v5` tag) and the real
 * `@actions/glob@0.5.1` it depends on: `getDefaultGlobOptions(includeHiddenFiles)`
 * sets `excludeHiddenFiles: !includeHiddenFiles`, and the traversal
 * (`DefaultGlobber`) skips an item "if (options.excludeHiddenFiles &&
 * path.basename(item.path).match(/^\./))" -- which fires on the search root
 * itself, before ever considering its contents. Reproduced with the real
 * library against a fixture `.build/` containing a real zip: 0 items found
 * with the default `excludeHiddenFiles: true`, 2 items (the directory and the
 * zip) found with `include-hidden-files: true`.
 *
 * `download-artifact@v5` has no `include-hidden-files` (or any hidden-file)
 * input at all -- confirmed against its real `action.yml` -- so nothing
 * downstream needs the equivalent flag; whatever bytes were actually
 * uploaded are what come back.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// cli/src/lib/ -> cli/src/ -> cli/ -> repo root
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const WORKFLOWS = ['deploy-infra.yml', 'deploy-app.yml']

interface UploadStep {
  line: number
  path: string | null
  includeHiddenFiles: boolean | null
}

/**
 * Every `actions/upload-artifact@vN` step in a workflow, with its `path:` and
 * `include-hidden-files:` values (or `null` if absent). Bounded per-step by
 * indentation: a step block runs from its `- uses:` line to the next line at
 * the same-or-shallower indent that starts a new list item or dedents below
 * the steps list.
 */
function uploadArtifactSteps(yaml: string): UploadStep[] {
  const lines = yaml.split('\n')
  const steps: UploadStep[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const m = /^(\s*)- uses:\s*actions\/upload-artifact@/.exec(line)
    if (!m) continue
    const stepIndent = (m[1] ?? '').length

    let path: string | null = null
    let includeHiddenFiles: boolean | null = null

    for (let j = i + 1; j < lines.length; j++) {
      const inner = lines[j] ?? ''
      if (inner.trim() === '') continue
      const indentMatch = /^(\s*)/.exec(inner)
      const indent = (indentMatch?.[1] ?? '').length
      // A new step (same-or-shallower list item) or a dedent out of `with:` ends this block.
      if (indent <= stepIndent) break

      const pathMatch = /^\s*path:\s*(\S+)\s*$/.exec(inner)
      if (pathMatch) path = (pathMatch[1] ?? '').replace(/^['"]|['"]$/g, '')

      const hiddenMatch = /^\s*include-hidden-files:\s*(\S+)\s*$/.exec(inner)
      if (hiddenMatch) includeHiddenFiles = hiddenMatch[1] === 'true' || hiddenMatch[1] === "'true'"
    }

    steps.push({ line: i + 1, path, includeHiddenFiles })
  }

  return steps
}

/** Final path segment starts with `.` -- the shape `upload-artifact` excludes by default, at the search-path ROOT. */
function targetsHiddenRoot(path: string): boolean {
  const segments = path.split('/').filter((s) => s.length > 0)
  const last = segments[segments.length - 1]
  return last !== undefined && last.startsWith('.')
}

describe('upload-artifact steps set include-hidden-files when their path is a dot-directory (#1663/#1774)', () => {
  it('the extractor finds upload-artifact steps in the real workflows', () => {
    // Guard the guard: if this returns nothing, every assertion below passes vacuously.
    const yaml = readFileSync(join(repoRoot, '.github/workflows/deploy-infra.yml'), 'utf8')
    expect(uploadArtifactSteps(yaml).length).toBeGreaterThan(0)
  })

  it('deploy-infra.yml uploads all three tfbuild-<env> .build/ directories with include-hidden-files: true', () => {
    const yaml = readFileSync(join(repoRoot, '.github/workflows/deploy-infra.yml'), 'utf8')
    const steps = uploadArtifactSteps(yaml)
    const tfbuildSteps = steps.filter((s) => s.path?.endsWith('/.build/'))

    // Guard the guard: exactly the three environments, not fewer (a step that
    // stopped matching would silently shrink this list to zero coverage).
    expect(tfbuildSteps).toHaveLength(3)

    const missing = tfbuildSteps
      .filter((s) => s.includeHiddenFiles !== true)
      .map(
        (s) =>
          `deploy-infra.yml:${s.line}  path=${s.path}  include-hidden-files=${String(s.includeHiddenFiles)}`,
      )

    expect(missing).toEqual([])
  })

  it.each(WORKFLOWS)(
    '%s: every upload-artifact step targeting a dot-directory sets include-hidden-files: true',
    (workflow) => {
      const path = join(repoRoot, '.github/workflows', workflow)
      if (!existsSync(path)) return
      const yaml = readFileSync(path, 'utf8')
      const steps = uploadArtifactSteps(yaml)

      const broken = steps
        .filter(
          (s) => s.path !== null && targetsHiddenRoot(s.path) && s.includeHiddenFiles !== true,
        )
        .map(
          (s) =>
            `${workflow}:${s.line}  path=${s.path}  is a dot-directory but include-hidden-files is not 'true' -- ` +
            'upload-artifact excludes the search-path root itself when it starts with "." (confirmed against the ' +
            'real v5 dist/upload/index.js), so this step silently uploads nothing.',
        )

      expect(broken).toEqual([])
    },
  )
})

describe('fail-first proof: the guard actually fires on the pre-fix #1663/#1774 shape', () => {
  const BROKEN_STEP = `
      - uses: actions/upload-artifact@v5
        with:
          name: tfbuild-dev
          path: infra/environments/dev/.build/
          retention-days: 1
          if-no-files-found: ignore
`

  const FIXED_STEP = `
      - uses: actions/upload-artifact@v5
        with:
          name: tfbuild-dev
          path: infra/environments/dev/.build/
          retention-days: 1
          if-no-files-found: ignore
          include-hidden-files: true
`

  const NON_HIDDEN_STEP = `
      - uses: actions/upload-artifact@v5
        with:
          name: tfplan-dev
          path: infra/environments/dev/tfplan
          retention-days: 1
          if-no-files-found: error
`

  it('FAILS on the broken shape: a .build/ upload with no include-hidden-files', () => {
    const steps = uploadArtifactSteps(BROKEN_STEP)
    expect(steps).toHaveLength(1)
    const step = steps[0]
    expect(step).toBeDefined()
    expect(step?.path).toBe('infra/environments/dev/.build/')
    expect(step && targetsHiddenRoot(step.path ?? '')).toBe(true)
    expect(step?.includeHiddenFiles).toBeNull()
  })

  it('PASSES on the fixed shape: the same step with include-hidden-files: true', () => {
    const steps = uploadArtifactSteps(FIXED_STEP)
    const step = steps[0]
    expect(step?.includeHiddenFiles).toBe(true)
  })

  it('does NOT flag a step whose path is not a dot-directory (e.g. tfplan)', () => {
    const steps = uploadArtifactSteps(NON_HIDDEN_STEP)
    const step = steps[0]
    expect(step).toBeDefined()
    expect(step && targetsHiddenRoot(step.path ?? '')).toBe(false)
  })
})
