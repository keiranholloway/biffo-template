import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isInstanceRepo } from './core-version.js'

/**
 * The TEMPLATE's own `infra/environments/dev/main.tf` keeps consuming the
 * template-owned environment channel (#1538, #1540).
 *
 * `module "core_api"` lives in a user-owned file whose `environment_variables`
 * is a literal map, and Terraform cannot add an argument to a module block from
 * another file. `infra/environments/dev/core-api-environment.core.tf` is the
 * template's only channel into that map, and it works solely because the module
 * block reads `merge(local.core_api_environment, { ... })`. Drop that one line
 * and the channel is still shipped, still declared template-owned, still
 * guarded by `services/api/tests/test_core_api_environment_distribution.py` —
 * and silently unread. Every instance scaffolded afterwards is then born
 * unadopted, with `BIFFO_PLUGIN_MEDIA_BUCKET` absent from its Lambda: #1538
 * again, with the fix apparently in place.
 *
 * ## Why this is gated, and why it is not a Python test
 *
 * `main.tf` is USER-OWNED. A template-owned check demanding content in an
 * unowned path is the #325/#327/#1452 class — the instance receives an
 * assertion about a file only it can change, and its CI reds on work it has not
 * done yet. `python-test-scope-scan.ts` enforces that for Python tests and
 * would (correctly) refuse this assertion if it lived there; the #367/#384
 * guard in `repo-layout-assertion-guard.test.ts` enforces the TypeScript half,
 * and requires exactly the `describe.skipIf(isInstanceRepo(repoRoot))` below —
 * with the paths built INSIDE the gated body, since a `.skipIf` cannot guard a
 * read that happens at import time.
 *
 * So: live in the template, where `main.tf` is the scaffold source every future
 * instance is born from; silent in an instance, where adopting the line is a
 * deliberate one-time change, documented in the PR that added the channel.
 * Merging that PR alone fixes nothing in any existing instance, and this guard
 * deliberately does not pretend otherwise.
 */
const repoRoot = join(__dirname, '..', '..', '..')

describe.skipIf(isInstanceRepo(repoRoot))(
  "the template's own core_api adopts the environment carve-out (#1538/#1540)",
  () => {
    const envDir = ['infra', 'environments', 'dev']
    const mainTf = join(repoRoot, ...envDir, 'main.tf')
    const carveOut = join(repoRoot, ...envDir, 'core-api-environment.core.tf')

    it('module "core_api" merges local.core_api_environment into its literal map', () => {
      const text = readFileSync(mainTf, 'utf8')
      expect(text).toMatch(/environment_variables\s*=\s*merge\(\s*local\.core_api_environment\s*,/)
    })

    it('the local it merges is actually declared, in the template-owned carve-out', () => {
      // Guarding the guard from the mirror-image failure: a `main.tf` reading a
      // local nothing declares fails `terraform plan` in every instance rather
      // than here, and this dev environment is not covered by CI's terraform
      // validate (deliberately scoped to modules/, #327).
      expect(existsSync(carveOut)).toBe(true)
      expect(readFileSync(carveOut, 'utf8')).toMatch(/^\s*core_api_environment\s*=\s*merge\(/m)
    })

    it('the keys the carve-out owns are no longer duplicated in the user-owned literal', () => {
      // Not cosmetic. The literal is merged SECOND, so a leftover copy there
      // wins over the carve-out — and the template would then be exercising a
      // channel it does not actually depend on, which is how a broken channel
      // stays green.
      const text = readFileSync(mainTf, 'utf8')
      for (const key of ['BIFFO_PLUGIN_MEDIA_BUCKET', 'BIFFO_PR_SIGNER_FUNCTION_NAME']) {
        expect(text).not.toMatch(new RegExp(`^\\s*${key}\\s*=`, 'm'))
      }
    })
  },
)
