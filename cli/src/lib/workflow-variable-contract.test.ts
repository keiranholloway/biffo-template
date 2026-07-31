/**
 * A workflow must not address an AWS resource through a variable that nothing
 * sets.
 *
 * `deploy-app.yml` consumes repository variables — bucket names, function names,
 * endpoints — that `deploy-infra.yml` publishes with `gh variable set` after
 * `terraform apply`. The two halves live in different files, run in different
 * workflows, and nothing connects them: adding the consumer without the
 * publisher yields an empty string at runtime, and an `aws` call against an
 * empty name fails somewhere far from the cause.
 *
 * This is the "code↔infra gap CI cannot catch" class the practices corpus
 * already records twice — an S3 prefix absent from IAM, a `*_base_url` never
 * wired. It is worth a guard rather than care, because the failure appears only
 * in an instance and only at deploy time, and **this repo never runs either
 * workflow**: biffo-template is non-deployable, it publishes to npm. Five
 * defects accumulated in `deploy-app.yml` for exactly that reason (#414, #415).
 *
 * ## The rule, and why it is shaped this way
 *
 * Every variable `deploy-app.yml` consumes must be one of:
 *
 * 1. **published** by `deploy-infra.yml` — a Terraform output, the normal case;
 * 2. **guarded** by an `if:` that tests it, which is how an optional feature
 *    correctly opts out (`PR_SIGNER_LAMBDA_NAME` is set by hand only when the
 *    endpoint control plane is in use, and its steps are skipped otherwise);
 * 3. **named config**, set once at `biffo init` rather than derived from infra.
 *
 * The allowlist in (3) is deliberately explicit and tiny. A general "or it might
 * be config" escape would make this assert nothing at all.
 *
 * What it deliberately does NOT assert: that a published variable has a
 * fallback. `deploy-app` can run before `deploy-infra` ever has, and for
 * `ARTIFACTS_BUCKET_NAME` that ordering matters enough to have a runtime
 * `head-bucket` probe (#994) — but `CORE_API_LAMBDA_NAME` and friends are
 * load-bearing with no sensible default, so requiring one everywhere would be
 * false precision.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (f: string) => readFileSync(join(repoRoot, '.github/workflows', f), 'utf8')

/**
 * Set once at `biffo init` / by the operator, not derived from a Terraform
 * output. Every entry needs a reason, and the list should stay short.
 */
const INIT_TIME_CONFIG = new Set([
  'AWS_REGION', // chosen at init; every aws call takes it
  'BIFFO_DEPLOY_ENABLED', // operator kill-switch for the whole deploy
  'RUNNER_LABEL', // which runner fleet this repo targets
  'PORTAL_TITLE', // instance branding (#389); no infra derives it, and unset is valid
])

const consumed = (yaml: string) =>
  new Set([...yaml.matchAll(/vars\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]))

const published = (yaml: string) =>
  new Set([...yaml.matchAll(/gh variable set ([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]))

/** Variables named in an `if:` condition — i.e. the step opts out when unset. */
const guarded = (yaml: string) =>
  new Set(
    yaml
      .split('\n')
      .filter((l) => /^\s*if:/.test(l))
      .flatMap((l) => [...l.matchAll(/vars\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1])),
  )

describe('deploy-app.yml variables are published by deploy-infra.yml', () => {
  const app = read('deploy-app.yml')
  const infra = read('deploy-infra.yml')

  it('has variables to check, so an empty match cannot pass as agreement', () => {
    expect(consumed(app).size).toBeGreaterThan(5)
    expect(published(infra).size).toBeGreaterThan(3)
  })

  it('consumes nothing that is neither published, guarded, nor named config', () => {
    const pub = published(infra)
    const grd = guarded(app)
    const orphans = [...consumed(app)]
      .filter((v) => !pub.has(v) && !grd.has(v) && !INIT_TIME_CONFIG.has(v))
      .sort()
    expect(orphans).toEqual([])
  })

  it('publishes the artifacts bucket the Lambda upload depends on', () => {
    // Named explicitly rather than left to the general rule: dropping the
    // deploy-infra half would silently return every instance to inline uploads
    // and the ~70MB cap, with a warning nobody reads (#994).
    expect(published(infra).has('ARTIFACTS_BUCKET_NAME')).toBe(true)
    expect(consumed(app).has('ARTIFACTS_BUCKET_NAME')).toBe(true)
  })
})
