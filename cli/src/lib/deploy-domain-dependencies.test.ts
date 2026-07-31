import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A product domain's Python dependencies must reach the deployed Lambda (#891).
 *
 * ADR-0022 gives an instance's product-domain code a user-owned home inside the
 * template-owned core API; `scripts/sync-domain-deps.sh` is what lets that code
 * declare Python packages the template does not ship, without forking
 * `services/api/pyproject.toml`. A mechanism that only resolved locally would be
 * worse than none — the instance would build on it and discover at deploy time
 * that the Lambda never got the packages.
 *
 * So the wiring is guarded, not assumed, and it is guarded here for the same
 * reason every other deploy guard in this directory is: **biffo-template never
 * runs `deploy-app.yml`.** It is non-deployable; it publishes to npm. Nothing in
 * this repo's own CI would ever notice the step being dropped, renamed, or added
 * to two of the three environment jobs and not the third — which is precisely
 * the drift shape `deploy-app.yml` has produced before (#410, #414, #351).
 */

const repoRoot = join(__dirname, '..', '..', '..')
const read = (p: string): string => readFileSync(join(repoRoot, p), 'utf8')

const deployApp = read('.github/workflows/deploy-app.yml')
const ci = read('.github/workflows/ci.yml')

describe('domain dependencies reach the Lambda package', () => {
  // One per environment job: dev, staging, prod.
  const invocations = [
    ...deployApp.matchAll(/^[ \t]*sh \.\.\/scripts\/sync-domain-deps\.sh[^\n]*/gm),
  ].map((m) => m[0].trim())

  it('is invoked by every environment job', () => {
    expect(invocations).toHaveLength(3)
  })

  it('installs into the package directory that gets zipped', () => {
    for (const invocation of invocations) {
      expect(invocation).toContain('--target package/')
    }
  })

  it('runs after the core dependency install, so core resolves first', () => {
    // The layering IS the supply-chain property: core is installed from the
    // frozen workspace lock, and domain packages go on top of it under a
    // constraint file. Reversing the order would let a domain's resolution
    // decide what core gets.
    const coreInstalls = [
      ...deployApp.matchAll(/^[ \t]*uv pip install -r requirements\.txt --target package\//gm),
    ].map((m) => m.index ?? -1)
    const domainInstalls = [
      ...deployApp.matchAll(/^[ \t]*sh \.\.\/scripts\/sync-domain-deps\.sh/gm),
    ].map((m) => m.index ?? -1)

    expect(coreInstalls).toHaveLength(3)
    expect(domainInstalls).toHaveLength(3)
    for (let i = 0; i < 3; i += 1) {
      expect(domainInstalls[i]).toBeGreaterThan(coreInstalls[i])
    }
  })

  it('runs before the trim, so domain transitives are trimmed too', () => {
    // The trim drops boto3/botocore/s3transfer because the Lambda runtime
    // provides them. A domain dependency installed after it would quietly put
    // ~10MB of runtime-provided packages back into a zip that already has a
    // size guard for a reason (#724).
    //
    // Scoped per core-API packaging step rather than by ordinal: other jobs in
    // this workflow (the PR signer, the plugin host) run their own trim, so a
    // whole-file index comparison would pair a domain install in the dev job
    // against some other job's trim and pass by accident.
    const coreInstalls = [
      ...deployApp.matchAll(/^[ \t]*uv pip install -r requirements\.txt --target package\//gm),
    ].map((m) => m.index ?? -1)
    expect(coreInstalls).toHaveLength(3)

    for (let i = 0; i < 3; i += 1) {
      const region = deployApp.slice(coreInstalls[i], coreInstalls[i + 1] ?? deployApp.length)
      const domainInstall = region.search(/^[ \t]*sh \.\.\/scripts\/sync-domain-deps\.sh/m)
      const trim = region.search(/^[ \t]*rm -rf boto3 botocore s3transfer/m)
      expect(domainInstall).toBeGreaterThanOrEqual(0)
      expect(trim).toBeGreaterThanOrEqual(0)
      expect(domainInstall).toBeLessThan(trim)
    }
  })
})

describe('domain dependencies are present for lint, types, tests and the audit', () => {
  it('ci.yml installs them alongside the workspace sync', () => {
    expect(ci).toContain('sh scripts/sync-domain-deps.sh')
  })

  it('installs them in the same step as uv sync, before every gate', () => {
    // Not merely "somewhere in the file": every Python gate — pyright, pytest,
    // bandit, pip-audit — is conditioned on `steps.install.outcome == 'success'`,
    // so a domain dependency installed in a later step would be invisible to the
    // type checker and unscanned by the advisory audit while CI stayed green.
    const install = ci.indexOf('sh scripts/sync-domain-deps.sh')
    const sync = ci.indexOf('uv sync --all-groups')
    const firstGate = ci.indexOf('uv run ruff check .')
    expect(sync).toBeGreaterThanOrEqual(0)
    expect(install).toBeGreaterThan(sync)
    expect(install).toBeLessThan(firstGate)
  })
})

describe('the script itself keeps its two load-bearing properties', () => {
  const script = read('scripts/sync-domain-deps.sh')

  it('reads the lock rather than re-resolving it (#410)', () => {
    expect(script).toMatch(/uv export(?:[^\n]*\\\n)*[^\n]*--frozen/)
  })

  it('installs domain packages under a constraint file derived from that lock', () => {
    // Without this a domain could pull a core dependency to a different version
    // transitively and overwrite it in the target directory, with nothing to
    // see. With it, uv fails the deploy instead.
    expect(script).toContain('--constraint "$constraints"')
  })

  it('validates the declarations before installing anything', () => {
    // Line-anchored: the script's header comment names `uv pip install` in
    // prose, and matching that instead would compare against a fixed point that
    // no reordering can ever move.
    const check = script.search(/^[ \t]*run_python .*--check$/m)
    const install = script.search(/^[ \t]*uv pip install /m)
    expect(check).toBeGreaterThanOrEqual(0)
    expect(install).toBeGreaterThanOrEqual(0)
    expect(check).toBeLessThan(install)
  })
})
