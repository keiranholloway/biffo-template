import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTemplateOwned, readCoreManifest } from './core-manifest.js'
import { isInstanceRepo } from './core-version.js'
import { findModuleTerraformFiles } from './cognito-invite-template-guard.js'
import { findPluginManifests } from './plugin-terraform-guard.js'
import { findWorkflowFiles } from './terraform-input-guard.js'
import {
  extractPythonTestAssertedPaths,
  findPythonTestAssertedPaths,
} from './python-test-scope-scan.js'

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
const runningInInstance = isInstanceRepo(repoRoot)

describe('META: template-owned checks must not assert over unowned paths (#325/#327)', () => {
  const manifest = readCoreManifest(repoRoot)

  /**
   * Guards that walk the repo tree RAW and assert over everything they reach.
   * Every path such a guard can find MUST be template-owned — the guard has no
   * ownership filter of its own, so its reach is its contract. To onboard a new
   * raw-tree guard, add its scan function here.
   *
   * `templateOnly` marks a scanner whose RAW reach is template-owned in the
   * template but not in an instance. That is not a violation of the rule above —
   * such a scanner carries its own ownership filter — but the raw-reach
   * assertion cannot express it, so it is skipped there (#367).
   *
   * `allowedUnowned` names specific user-owned paths a scanner's raw reach may
   * legitimately include, individually, without weakening the rule for
   * everything else it finds. `*.instance.yml` (tabsii-platform#521) is the
   * first case: it is user-owned BY DESIGN the moment it exists, so whoever
   * owns it can fix any real finding directly, with no upstream release
   * required — unlike the #325 trap, where the instance had no way to receive
   * or repair what the guard flagged.
   */
  const rawTreeScanners: {
    name: string
    scan: (root: string) => string[]
    templateOnly?: boolean
    allowedUnowned?: (path: string) => boolean
  }[] = [
    {
      name: 'terraform-input-guard.findWorkflowFiles',
      scan: findWorkflowFiles,
      allowedUnowned: (path) => path.endsWith('.instance.yml'),
    },
    // plugin-terraform-guard additionally self-filters through isTemplateOwned
    // for instances (see plugin-terraform-guard.test.ts). In the TEMPLATE its
    // raw reach is already entirely template-owned, which this asserts; in an
    // instance the same walk also finds user-owned `services/<name>/` plugins,
    // which is exactly what that self-filter exists to handle.
    {
      name: 'plugin-terraform-guard.findPluginManifests',
      scan: findPluginManifests,
      templateOnly: true,
    },
    // Scans the modules/ tree for Cognito invite_message_template blocks (#356);
    // modules/ is wholly template-owned, which this asserts.
    {
      name: 'cognito-invite-template-guard.findModuleTerraformFiles',
      scan: findModuleTerraformFiles,
    },
    // #1454: extends the META guard into Python tests under services/api/tests/
    // (and any other template-owned test tree, e.g. a skeleton's own copy).
    // Self-filters through isTemplateOwned the same way findPluginManifests
    // does — only a template-owned test FILE is walked at all — so this is
    // not templateOnly; services/api/tests/instance/ (explicitly userOwned)
    // is excluded by that filter rather than by allowedUnowned.
    //
    // The three allowances below are the same class of exception
    // *.instance.yml is: each is a path an instance owns and can fix
    // directly, and the test that reaches it does not demand the content
    // match anything the template dictates — it checks the path's OWN
    // internal consistency (a DDL immutability diff against git history, an
    // Alembic chain's own down_revision links, an existence check used only
    // to tell "is this an instance" apart from "is this the template"). That
    // is categorically different from #1452's shape, where the test asserted
    // the CONTENT of a path the instance has no channel to fix because the
    // template controls it.
    {
      name: 'python-test-scope-scan.findPythonTestAssertedPaths',
      scan: findPythonTestAssertedPaths,
      allowedUnowned: (path) =>
        path === 'biffo.core.json' ||
        path === 'db/imports' ||
        path.startsWith('db/imports/') ||
        path === 'services/api/migrations/versions' ||
        path.startsWith('services/api/migrations/versions/'),
    },
  ]

  const applicableScanners = rawTreeScanners.filter((s) => !(s.templateOnly && runningInInstance))

  it.each(applicableScanners)(
    '$name reaches only template-owned paths',
    ({ name, scan, allowedUnowned }) => {
      const reached = scan(repoRoot)
      // The guard must actually reach something — a scanner that finds nothing
      // would pass this vacuously and hide a broken walk. Printed, not just
      // asserted-nonzero: a scanner that runs and matches nothing looks
      // identical to one that runs and finds no problems, and that confusion
      // is exactly what left this META guard blind to Python for as long as
      // it was (#1454).
      console.log(`  [coverage] ${name}: ${reached.length} path(s) reached`)
      expect(reached.length).toBeGreaterThan(0)
      const unowned = reached.filter(
        (p) => !isTemplateOwned(p, manifest) && !(allowedUnowned && allowedUnowned(p)),
      )
      expect(unowned).toEqual([])
    },
  )

  it('negative control: the assertion FAILS when a scan reaches an unowned path', () => {
    // Proof the mechanism above can fail — otherwise it proves nothing. These
    // are real user-owned paths per the manifest; the filter must catch them.
    expect(isTemplateOwned('infra/environments/dev/main.tf', manifest)).toBe(false)
    expect(isTemplateOwned('services/stripe-sync/handler.py', manifest)).toBe(false)

    const pretendReach = ['.github/workflows/ci.yml', 'infra/environments/dev/main.tf']
    const unowned = pretendReach.filter((p) => !isTemplateOwned(p, manifest))
    expect(unowned).toEqual(['infra/environments/dev/main.tf'])
  })

  it('#1454 negative control: a Python test asserting over an unowned path is caught by the EXTENDED guard', () => {
    // The exact defect #1452 shipped, reconstructed: a template-owned test
    // resolving the repo root and asserting over a path core-manifest.json
    // does not list as templateOwned (here: an invented file under the
    // wholly userOwned apps/ tree, standing in for #1452's real
    // infra/environments/dev/plugin-storage.core.tf before it was added to
    // templateOwned).
    const fixtureSource = [
      '_REPO_ROOT = Path(__file__).resolve().parents[3]',
      '_TARGET = _REPO_ROOT / "apps" / "some-user-owned-file.tsx"',
    ].join('\n')
    const fixtureFileDir = 'services/api/tests' // where the real #1452 file lived

    const reached = extractPythonTestAssertedPaths(fixtureSource, fixtureFileDir)
    expect(reached).toEqual(['apps/some-user-owned-file.tsx'])

    // Proves the EXTENDED guard catches it:
    const unowned = reached.filter((p) => !isTemplateOwned(p, manifest))
    expect(unowned).toEqual(['apps/some-user-owned-file.tsx'])

    // Proves the OLD guard (the three scanners this repo carried before
    // #1454) could not have: none of them walks Python source at all, so
    // this fixture — a file that is neither a workflow YAML, a plugin
    // manifest, nor a Terraform module — is invisible to every one of them
    // by construction. There is nothing to assert here beyond that fact:
    // findWorkflowFiles/findPluginManifests/findModuleTerraformFiles all
    // operate on file EXTENSIONS and DIRECTORIES this fixture never touches
    // (no .yml, no biffo.plugin.json, no modules/ .tf file), which is
    // exactly the "categorically outside what it looks at" finding #1454
    // itself made when it corrected the original #325-literal-matching
    // theory.
  })
})
