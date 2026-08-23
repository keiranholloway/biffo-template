import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTemplateOwned, readCoreManifest } from './core-manifest.js'
import {
  checkTerraformInput,
  checkWorkflowSource,
  findWorkflowFiles,
  stripComments,
} from './terraform-input-guard.js'
// Not mkdtempSync: `no-raw-mkdtemp.test.ts` walks the AST of every test file and
// fails a direct call. makeTmpDir registers the directory for an automatic sweep.
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `vi.hoisted` because `vi.mock` factories are hoisted above ordinary
 * top-level declarations; a plain `let` read from the factory is in its
 * temporal dead zone when the factory runs.
 */
const race = vi.hoisted(() => ({ statSyncThrowsFor: null as string | null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    /**
     * Pass-through unless a test opts in, so every other consumer of
     * `node:fs` in this file — including `makeTmpDir` — behaves exactly as
     * normal. Simulates the real race (#1713): another process removes an
     * entry between `walk`'s `readdirSync` and its `statSync` on that same
     * entry, which throws ENOENT for a path that was real a moment ago.
     */
    statSync: (p: Parameters<typeof actual.statSync>[0]): ReturnType<typeof actual.statSync> => {
      if (race.statSyncThrowsFor !== null && String(p) === race.statSyncThrowsFor) {
        const err = new Error(
          `ENOENT: no such file or directory, stat '${p}'`,
        ) as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return actual.statSync(p)
    },
  }
})

afterEach(() => {
  race.statSyncThrowsFor = null
})

const repoRoot = join(__dirname, '..', '..', '..')

/** The exact shape of the bug in #322: import with no -input=false. */
const BROKEN = `
name: Deploy
env:
  TF_INPUT: '0'
jobs:
  go:
    steps:
      - run: |
          terraform import 'aws_route53_zone.main[0]' "$ZONE_ID"
`

const FIXED = `
name: Deploy
env:
  TF_INPUT: '0'
jobs:
  go:
    steps:
      - run: |
          terraform import -input=false 'aws_route53_zone.main[0]' "$ZONE_ID"
`

describe('stripComments', () => {
  it('removes YAML and shell comments', () => {
    expect(stripComments('  # terraform apply -auto-approve\n')).not.toContain('terraform')
    expect(stripComments('run: terraform apply # do it\n')).toContain('terraform apply')
  })

  it('keeps a # that is not preceded by whitespace', () => {
    expect(stripComments('key: value#notacomment')).toContain('value#notacomment')
  })
})

describe('checkWorkflowSource', () => {
  it('FAILS on the real #322 regression', () => {
    const violations = checkWorkflowSource('bad.yml', BROKEN)
    expect(violations).toHaveLength(1)
    expect(violations[0].message).toContain('-input=false')
  })

  it('passes once the flag is present', () => {
    expect(checkWorkflowSource('good.yml', FIXED)).toEqual([])
  })

  it('does not accept a comment in place of the code', () => {
    // The trap a previous guard in this repo fell into: matching its own prose.
    const commentOnly = FIXED.replace(
      'terraform import -input=false \'aws_route53_zone.main[0]\' "$ZONE_ID"',
      'terraform import \'aws_route53_zone.main[0]\' "$ZONE_ID" # -input=false',
    )
    expect(checkWorkflowSource('trap.yml', commentOnly)).toHaveLength(1)
  })

  it('does not flag prose that merely mentions a terraform command', () => {
    const prose = `
name: Docs
env:
  NODE_VERSION: '22'
jobs:
  go:
    steps:
      # This job runs after terraform apply completes.
      - run: echo hi
`
    expect(checkWorkflowSource('prose.yml', prose)).toEqual([])
  })

  it('flags every guarded subcommand', () => {
    for (const sub of ['init', 'plan', 'apply', 'destroy', 'import', 'refresh']) {
      const src = `env:\n  TF_INPUT: '0'\njobs:\n  a:\n    steps:\n      - run: terraform ${sub}\n`
      expect(checkWorkflowSource(`${sub}.yml`, src)).toHaveLength(1)
    }
  })

  it('does not flag read-only subcommands', () => {
    const src = `jobs:\n  a:\n    steps:\n      - run: terraform output -raw url\n`
    expect(checkWorkflowSource('out.yml', src)).toEqual([])
  })

  it('requires TF_INPUT when terraform runs', () => {
    const noEnv = `jobs:\n  a:\n    steps:\n      - run: terraform apply -input=false -auto-approve\n`
    const violations = checkWorkflowSource('noenv.yml', noEnv)
    expect(violations).toHaveLength(1)
    expect(violations[0].message).toContain('TF_INPUT')
  })

  it('does not require TF_INPUT in workflows that never run terraform', () => {
    expect(
      checkWorkflowSource('js.yml', 'jobs:\n  a:\n    steps:\n      - run: pnpm test\n'),
    ).toEqual([])
  })

  it('recognises -auto-approve as insufficient on its own', () => {
    const src = `env:\n  TF_INPUT: '0'\njobs:\n  a:\n    steps:\n      - run: terraform apply -auto-approve\n`
    expect(checkWorkflowSource('aa.yml', src)).toHaveLength(1)
  })
})

describe('findWorkflowFiles', () => {
  it('finds both root and skeleton workflows', () => {
    const files = findWorkflowFiles(repoRoot)
    expect(files).toContain('.github/workflows/deploy-global.yml')
    expect(files.some((f) => f.startsWith('_skeletons/'))).toBe(true)
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true)
  })
})

describe('the repository itself', () => {
  it('has no Terraform invocation that can hang on stdin', () => {
    expect(checkTerraformInput(repoRoot)).toEqual([])
  })
})

/**
 * Issue #325. This guard lives under the template-owned `cli/`, so `biffo core
 * upgrade` distributes it to every instance. Anything it *scans* must therefore
 * be template-owned too — otherwise the upgrade ships an instance an assertion
 * whose subject it has no mechanism to receive, and the instance's CI goes red
 * on files it neither wrote nor can fix. That is exactly what 0.41.3 did: the
 * guard reached into `_skeletons/`, which was owned by neither list and so
 * user-owned by the manifest's fail-closed default.
 *
 * The general rule, of which this is one instance: a template-owned check must
 * not assert over paths the template does not own.
 */
describe('scan scope stays inside the template-owned boundary (#325)', () => {
  const manifest = readCoreManifest(repoRoot)

  it('scans at least the root and skeleton workflow trees', () => {
    const files = findWorkflowFiles(repoRoot)
    expect(files.some((f) => f.startsWith('.github/workflows/'))).toBe(true)
    expect(files.some((f) => f.startsWith('_skeletons/'))).toBe(true)
  })

  it('scans only template-owned paths, so every instance can receive the fix', () => {
    // `*.instance.yml` is a deliberate exception, not the #325 trap: that trap
    // was a guard reaching a path with NO owner at all, so an instance received
    // an assertion on a file it could not receive or repair. A `.instance.yml`
    // is user-owned BY DESIGN from the moment it exists (tabsii-platform#521 is
    // the first real one) -- whoever owns it can fix any real finding directly,
    // no upstream release required. Excluding it here is about scope, not about
    // disabling the underlying scan: `checkTerraformInput` above still runs
    // against these files and would still catch a genuine violation in one.
    const unowned = findWorkflowFiles(repoRoot).filter(
      (f) => !isTemplateOwned(f, manifest) && !f.endsWith('.instance.yml'),
    )
    expect(unowned).toEqual([])
  })

  it('keeps _skeletons/ template-owned', () => {
    expect(
      isTemplateOwned('_skeletons/sibling-template/.github/workflows/deploy.yml', manifest),
    ).toBe(true)
    expect(isTemplateOwned('_skeletons/plugin-template/.github/workflows/ci.yml', manifest)).toBe(
      true,
    )
  })
})

/**
 * Issue #1565. `findWorkflowFiles`'s docstring already claimed it "skips
 * vendored trees", but the walk only ever excluded `node_modules`, `.git` and
 * `.worktrees` — so a plugin vendored whole into `services/<name>/` (by
 * `biffo plugin install`/`upgrade`) had its own `.github/workflows/ci.yml`
 * collected and flagged, even though that workflow never runs in the instance
 * and is not the instance's to fix (measured on biffo-platform#164, against
 * `services/idea-scout/.github/workflows/ci.yml`).
 *
 * These fixtures build a throwaway repo tree rather than asserting against
 * this repo's real `services/`, because the template carries no vendored
 * plugin with its own `.github/` — `services/_plugins/{orchestrator,
 * agent-runtime}` have a `biffo.plugin.json` each but no workflow directory of
 * their own to prove the skip against.
 */
describe('vendored plugin .github/ is skipped, but only there (#1565)', () => {
  const buildFixture = (): string => {
    const root = makeTmpDir('tf-input-guard-vendor')

    // A vendored plugin with its own CI workflow AND a manifest beside it —
    // the discriminator the skip must key on.
    const vendoredCi = join(root, 'services', 'idea-scout', '.github', 'workflows')
    mkdirSync(vendoredCi, { recursive: true })
    writeFileSync(join(root, 'services', 'idea-scout', 'biffo.plugin.json'), '{}')
    writeFileSync(join(vendoredCi, 'ci.yml'), BROKEN)

    // Same shape, one directory over `services/`, with NO manifest beside it.
    // Proves the discriminator is the manifest, not "lives under services/".
    const unmanifestedCi = join(root, 'services', 'plain-service', '.github', 'workflows')
    mkdirSync(unmanifestedCi, { recursive: true })
    writeFileSync(join(unmanifestedCi, 'ci.yml'), BROKEN)

    // The plugin-repo birth skeleton: carries a `biffo.plugin.json` too, but
    // MUST stay scanned — see the module docstring on `vendoredPluginServiceDirs`.
    const skeletonCi = join(root, '_skeletons', 'plugin-template', '.github', 'workflows')
    mkdirSync(skeletonCi, { recursive: true })
    writeFileSync(join(root, '_skeletons', 'plugin-template', 'biffo.plugin.json'), '{}')
    writeFileSync(join(skeletonCi, 'ci.yml'), BROKEN)

    // The repo's own root workflow — always scanned, regardless of the above.
    const rootCi = join(root, '.github', 'workflows')
    mkdirSync(rootCi, { recursive: true })
    writeFileSync(join(rootCi, 'ci.yml'), BROKEN)

    return root
  }

  it('does not collect a vendored plugin workflow (services/<name>/ with a manifest beside it)', () => {
    const files = findWorkflowFiles(buildFixture())
    expect(files).not.toContain('services/idea-scout/.github/workflows/ci.yml')
  })

  it('DOES collect the same file shape when no manifest sits beside it — the discriminator is the manifest, not the path', () => {
    const files = findWorkflowFiles(buildFixture())
    expect(files).toContain('services/plain-service/.github/workflows/ci.yml')
  })

  it('still collects _skeletons/plugin-template/.github/workflows/ even though it too carries a manifest', () => {
    // This is the test that fails if the skip is later broadened from
    // "services/<name>/" to "any directory with a biffo.plugin.json" — that
    // broadening would silently stop guarding the workflow every new plugin
    // repo is born with, reintroducing #322 at the source.
    const files = findWorkflowFiles(buildFixture())
    expect(files).toContain('_skeletons/plugin-template/.github/workflows/ci.yml')
  })

  it("still collects the repo's own root .github/workflows/", () => {
    const files = findWorkflowFiles(buildFixture())
    expect(files).toContain('.github/workflows/ci.yml')
  })

  it('still reports a real violation in a file that stays in scope, while the vendored one is silent', () => {
    const root = buildFixture()
    const violations = checkTerraformInput(root)
    const files = violations.map((v) => v.file)

    expect(files).toContain('.github/workflows/ci.yml')
    expect(files).toContain('services/plain-service/.github/workflows/ci.yml')
    expect(files).toContain('_skeletons/plugin-template/.github/workflows/ci.yml')
    expect(files).not.toContain('services/idea-scout/.github/workflows/ci.yml')
  })
})

/**
 * #1713: `walk` recurses from `repoRoot` unfiltered and calls `statSync` on
 * every entry with no `try`/`catch`. A concurrently-mutated `.venv` (another
 * vitest worker's `uv sync`/pip-audit fixture, or a real `.venv` at the repo
 * root) removes entries between `readdirSync` and `statSync`, and the bare
 * `statSync` throws ENOENT for an entry that existed a moment ago — failing
 * this test file for a reason unrelated to what it actually checks.
 *
 * Two independent halves, because they close different gaps:
 *   1. `.venv` added to the skip set — removes the one directory known to
 *      churn like this, matching `skeleton-drift-guard.ts` /
 *      `plugin-collision-guard.ts`.
 *   2. `statSync` wrapped in try/catch — makes ANY concurrently-removed
 *      entry harmless, not just `.venv`. Skipping `.venv` alone would leave
 *      the class open for the next directory somebody churns.
 */
describe('walk tolerates a concurrently-mutated tree (#1713)', () => {
  it('does not throw when an entry is removed between readdirSync and statSync', () => {
    const root = makeTmpDir('tf-input-guard-race')
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), BROKEN)
    // A plain directory — not `.venv` — races out from under statSync. This
    // is the general try/catch half: the skip list cannot cover it by name.
    mkdirSync(join(root, 'build-output'), { recursive: true })

    race.statSyncThrowsFor = join(root, 'build-output')

    expect(() => findWorkflowFiles(root)).not.toThrow()
    expect(findWorkflowFiles(root)).toContain('.github/workflows/ci.yml')
  })

  it('skips .venv without statting it, even while it is being torn down', () => {
    const root = makeTmpDir('tf-input-guard-venv')
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), BROKEN)
    mkdirSync(join(root, '.venv', 'lib', 'python3.13', 'site-packages'), { recursive: true })
    writeFileSync(join(root, '.venv', 'lib', 'python3.13', 'site-packages', 'pkg.txt'), 'x')

    // Always throws for anything under .venv — proves the skip happens
    // before any stat is attempted, not merely that a caught throw is
    // tolerated.
    race.statSyncThrowsFor = join(root, '.venv')

    const files = findWorkflowFiles(root)
    expect(files).toContain('.github/workflows/ci.yml')
    expect(files.some((f) => f.startsWith('.venv'))).toBe(false)
  })
})
