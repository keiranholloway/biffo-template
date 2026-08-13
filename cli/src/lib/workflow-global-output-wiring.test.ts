/**
 * A value produced by `infra/global` must actually reach the regional stacks
 * (issue #1574).
 *
 * ## The class, not the instance
 *
 * `infra/global` is a separate Terraform state in us-east-1: it owns the things
 * that must live there regardless of the instance's own region — the hosted
 * zone, the wildcard ACM certificate, and (since #1529) the error-status-demote
 * Lambda@Edge function. Nothing references it; its values reach the regional
 * stacks by a **three-hop chain of loose string names**:
 *
 *   `infra/global` output  →  `gh variable set X` in deploy-global.yml
 *                          →  `TF_VAR_x: ${{ vars.X }}` in deploy-infra.yml
 *
 * Every hop is a name typed twice in files that never see each other, and each
 * variable defaults to `""`, so a missing hop is not an error — it is silence.
 * #1529 shipped complete and correct Terraform whose middle and final hops were
 * never written, and the result was a fix that merged, deployed, tagged, and
 * did **nothing**: every `/api/*` path on the affected instance kept returning
 * 80,769 bytes of the portal's `index.html`, and no check anywhere went red.
 *
 * This repo cannot catch that by running anything: biffo-template is
 * non-deployable, it publishes to npm, so neither workflow ever executes here.
 * The same reasoning as `workflow-variable-contract.test.ts`, one stack further
 * out — that test asserts deploy-app consumes nothing deploy-infra fails to
 * publish; this one asserts deploy-infra consumes everything deploy-global
 * produces.
 *
 * ## The rule
 *
 * The set is derived, not listed: a variable in `infra/environments/dev` whose
 * description says **"Output from infra/global"** declares its own membership.
 * For each such variable:
 *
 *   1. `infra/global/outputs.tf` publishes an output of the same name;
 *   2. `deploy-global.yml` exports it with `gh variable set <UPPER_NAME>`;
 *   3. every workflow `env:` block that wires ONE of them wires ALL of them,
 *      as `TF_VAR_<name>: ${{ vars.<UPPER_NAME> }}`.
 *
 * Rule 3 is shaped that way on purpose. Counting jobs would need updating every
 * time an environment is added; keying off the peers means a new global-derived
 * value is checked in exactly the places its siblings are already trusted, and
 * a job that wires none (a plan job that needs no CDN) is left alone.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(__dirname, '..', '..', '..')
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), 'utf8')

/** Workflows that hand variables to Terraform for a regional stack. */
const CONSUMER_WORKFLOWS = ['deploy-infra.yml', 'destroy-infra.yml']

/**
 * Variables that declare themselves as coming from the global stack, by the
 * convention their descriptions already use.
 */
function globalDerivedVariables(): string[] {
  const tf = read('infra', 'environments', 'dev', 'variables.tf')
  const names: string[] = []
  const re = /variable\s+"([a-z0-9_]+)"\s*\{([\s\S]*?)\n\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tf)) !== null) {
    if (/Output from infra\/global/i.test(m[2])) names.push(m[1])
  }
  return names.sort()
}

/**
 * Every `env:` mapping in a workflow, as raw text. Indentation-based rather
 * than a YAML parse: the cli has no YAML dependency, and the sibling workflow
 * guards in this directory read these files the same way.
 */
function envBlocks(yaml: string): string[] {
  const lines = yaml.split('\n')
  const blocks: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const header = /^(\s*)env:\s*$/.exec(lines[i])
    if (!header) continue
    const indent = header[1].length
    const body: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (line.trim() === '') {
        body.push(line)
        continue
      }
      if (line.length - line.trimStart().length <= indent) break
      body.push(line)
    }
    blocks.push(body.join('\n'))
  }
  return blocks
}

const upper = (name: string) => name.toUpperCase()

describe('infra/global outputs reach the regional stacks (#1574)', () => {
  const names = globalDerivedVariables()

  it('finds the variables it asserts over', () => {
    // Guards the guard. If the description convention is reworded away, this
    // test would otherwise pass by having nothing to check — the fail-open
    // shape that produced #1574 in the first place.
    expect(names.length).toBeGreaterThanOrEqual(3)
    expect(names).toContain('acm_certificate_arn')
    expect(names).toContain('hosted_zone_id')
    expect(names).toContain('error_status_restore_lambda_arn')
  })

  it('every environment declares each of them, so none is dev-only', () => {
    for (const env of ['staging', 'prod']) {
      const tf = read('infra', 'environments', env, 'main.tf')
      for (const name of names) {
        expect(tf, `${env} does not declare variable ${name}`).toContain(`variable "${name}"`)
      }
    }
  })

  it('infra/global publishes an output for each', () => {
    const outputs = read('infra', 'global', 'outputs.tf')
    for (const name of names) {
      expect(outputs, `infra/global/outputs.tf has no output "${name}"`).toContain(
        `output "${name}"`,
      )
    }
  })

  it('deploy-global.yml exports each as a repository variable', () => {
    const global = read('.github', 'workflows', 'deploy-global.yml')
    for (const name of names) {
      expect(
        global,
        `deploy-global.yml never runs \`gh variable set ${upper(name)}\`, so ` +
          `infra/global's ${name} output can never reach deploy-infra.yml — the ` +
          `exact gap that made #1529 ship inert (#1574).`,
      ).toContain(`gh variable set ${upper(name)}`)
    }
  })

  it.each(CONSUMER_WORKFLOWS)('%s wires all of them wherever it wires any', (workflow) => {
    const blocks = envBlocks(read('.github', 'workflows', workflow))
    const relevant = blocks.filter((b) => names.some((n) => b.includes(`TF_VAR_${n}:`)))

    // One per environment (dev/staging/prod). Asserted as a floor rather than
    // an exact count so adding an environment does not force a test edit.
    expect(
      relevant.length,
      `${workflow} passes no global-derived TF_VAR at all`,
    ).toBeGreaterThanOrEqual(3)

    for (const block of relevant) {
      for (const name of names) {
        expect(
          block,
          `${workflow}: an env block wires some infra/global values but not ` +
            `TF_VAR_${name}. A Terraform variable nothing sets defaults to "" and ` +
            `the feature it gates ships switched off, silently (#1574).`,
        ).toContain(`TF_VAR_${name}: \${{ vars.${upper(name)} }}`)
      }
    }
  })
})

describe('the error-status fix is wired end to end (#1529, #1574)', () => {
  // Named explicitly rather than left to the general rule above, for the same
  // reason ARTIFACTS_BUCKET_NAME is in workflow-variable-contract.test.ts:
  // losing this specific chain returns every instance to serving 80,769 bytes
  // of index.html on API errors, with nothing red anywhere to say so.
  it('deploy-global publishes it and deploy-infra consumes it', () => {
    expect(read('.github', 'workflows', 'deploy-global.yml')).toContain(
      'gh variable set ERROR_STATUS_RESTORE_LAMBDA_ARN',
    )
    expect(read('.github', 'workflows', 'deploy-infra.yml')).toContain(
      'TF_VAR_error_status_restore_lambda_arn: ${{ vars.ERROR_STATUS_RESTORE_LAMBDA_ARN }}',
    )
  })

  it('clears the variable when the global stack does not publish one', () => {
    // The pair must track the global stack in lockstep: a stale ARN left behind
    // after the function is removed pins a CloudFront association to a dead
    // Lambda version, and `infra/` is user-owned, so an instance can genuinely
    // lack the function while running this template-owned workflow.
    const global = read('.github', 'workflows', 'deploy-global.yml')
    expect(global).toContain('gh variable delete ERROR_STATUS_RESTORE_LAMBDA_ARN')
  })

  it('reads the global output tolerantly, so instances without it still get DNS and certs', () => {
    const global = read('.github', 'workflows', 'deploy-global.yml')
    expect(global).toMatch(/terraform output -raw error_status_restore_lambda_arn[^\n]*\|\|\s*true/)
  })
})
