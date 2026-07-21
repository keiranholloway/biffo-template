import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTemplateOwned, readCoreManifest } from './core-manifest.js'
import { findModuleTerraformFiles } from './cognito-invite-template-guard.js'
import { findPluginManifests } from './plugin-terraform-guard.js'
import { findWorkflowFiles } from './terraform-input-guard.js'

/**
 * META guard for the #325/#327 class.
 *
 * The rule: **a template-owned check must not assert over paths the template
 * does not own.** Every guard here lives under the template-owned `cli/`, so
 * `biffo core upgrade` distributes it to every instance. If such a guard reaches
 * a path the instance owns, the instance receives an assertion whose subject it
 * cannot receive or repair, and its CI goes red on files it never wrote — which
 * is exactly what #322/#325 did (a guard reaching into unowned `_skeletons/`).
 *
 * This test encodes that rule as an executable invariant over the repo-walking
 * guards, so the class cannot silently return: adding a new tree-walking guard
 * whose reach escapes the template-owned boundary fails here.
 *
 * It runs against the REAL manifest and the REAL scan functions — not a
 * restatement of them — and includes a negative control proving the assertion
 * mechanism can actually fail. A guard that can only pass proves nothing (the
 * trap a previous guard in this repo fell into by matching its own prose).
 */
const repoRoot = join(__dirname, '..', '..', '..')

describe('META: template-owned checks must not assert over unowned paths (#325/#327)', () => {
  const manifest = readCoreManifest(repoRoot)

  /**
   * Guards that walk the repo tree RAW and assert over everything they reach.
   * Every path such a guard can find MUST be template-owned — the guard has no
   * ownership filter of its own, so its reach is its contract. To onboard a new
   * raw-tree guard, add its scan function here.
   */
  const rawTreeScanners: { name: string; scan: (root: string) => string[] }[] = [
    { name: 'terraform-input-guard.findWorkflowFiles', scan: findWorkflowFiles },
    // plugin-terraform-guard additionally self-filters through isTemplateOwned
    // for instances (see plugin-terraform-guard.test.ts). In the TEMPLATE its
    // raw reach is already entirely template-owned, which this asserts.
    { name: 'plugin-terraform-guard.findPluginManifests', scan: findPluginManifests },
    // Scans the modules/ tree for Cognito invite_message_template blocks (#356);
    // modules/ is wholly template-owned, which this asserts.
    {
      name: 'cognito-invite-template-guard.findModuleTerraformFiles',
      scan: findModuleTerraformFiles,
    },
  ]

  it.each(rawTreeScanners)('$name reaches only template-owned paths', ({ scan }) => {
    const reached = scan(repoRoot)
    // The guard must actually reach something — a scanner that finds nothing
    // would pass this vacuously and hide a broken walk.
    expect(reached.length).toBeGreaterThan(0)
    const unowned = reached.filter((p) => !isTemplateOwned(p, manifest))
    expect(unowned).toEqual([])
  })

  it('negative control: the assertion FAILS when a scan reaches an unowned path', () => {
    // Proof the mechanism above can fail — otherwise it proves nothing. These
    // are real user-owned paths per the manifest; the filter must catch them.
    expect(isTemplateOwned('infra/environments/dev/main.tf', manifest)).toBe(false)
    expect(isTemplateOwned('services/stripe-sync/handler.py', manifest)).toBe(false)

    const pretendReach = ['.github/workflows/ci.yml', 'infra/environments/dev/main.tf']
    const unowned = pretendReach.filter((p) => !isTemplateOwned(p, manifest))
    expect(unowned).toEqual(['infra/environments/dev/main.tf'])
  })
})
