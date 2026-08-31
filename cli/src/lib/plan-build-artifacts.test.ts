import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs so this runs on bare node in the Plan job,
// which sets up Terraform and AWS and nothing else. Imported here so the
// logic has one home rather than a TypeScript copy that can drift from it --
// same arrangement as destructive-plan.mjs / check-destructive-plan.mjs.
import { extractArchiveFileOutputPaths } from '../../../scripts/plan-build-artifacts.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => JSON.parse(readFileSync(join(here, '__fixtures__', name), 'utf8'))

/**
 * All three fixtures are REAL `terraform show -json` output, not
 * hand-written JSON -- captured against terraform 1.9.8 with the real
 * `hashicorp/archive` provider, via:
 *
 *   terraform init -input=false
 *   terraform plan -input=false -out=tfplan
 *   terraform show -json tfplan > plan.json
 *
 * `archive-file-in-module-plan.json` reproduces biffo-template#1772's own
 * repro exactly: a `data "archive_file"` declared inside a reusable module
 * (`${path.module}/build/thing.zip`), consumed by an `aws_lambda_function`'s
 * `filename`/`source_code_hash` -- the same shape this repo's own
 * `modules/cloud/aws/compute/main.tf` used before #1457/#1460
 * (`git show d2b0fbbd~1:modules/cloud/aws/compute/main.tf`).
 * `archive-file-under-build-plan.json` is the shape the #1774 fix already
 * transports (an env-root `archive_file` under `./.build/`), captured so the
 * exclusion in collect-plan-build-artifacts.mjs (tested separately) has a
 * real fixture to run against. `no-archive-file-plan.json` is the common
 * case: no archive_file at all.
 */
describe('extractArchiveFileOutputPaths', () => {
  it('finds an archive_file output_path declared inside a reusable module (#1772 repro)', () => {
    const plan = fixture('archive-file-in-module-plan.json')
    expect(extractArchiveFileOutputPaths(plan)).toEqual([
      '../../../modules/lambda-thing/build/thing.zip',
    ])
  })

  it('finds an archive_file output_path at the environment root, under .build/', () => {
    const plan = fixture('archive-file-under-build-plan.json')
    expect(extractArchiveFileOutputPaths(plan)).toEqual(['./.build/root-thing.zip'])
  })

  it('returns nothing for a plan with no archive_file data source at all', () => {
    const plan = fixture('no-archive-file-plan.json')
    expect(extractArchiveFileOutputPaths(plan)).toEqual([])
  })

  it('ignores a managed resource that merely shares fields with archive_file (e.g. filename)', () => {
    // Constructed, not captured: exercises the type-discrimination logic on
    // an adjacent shape (mode: managed, not data) the real fixtures don't
    // happen to hit head-on.
    const plan = {
      resource_changes: [
        {
          address: 'aws_lambda_function.thing',
          mode: 'managed',
          type: 'aws_lambda_function',
          change: { actions: ['create'], after: { output_path: '/tmp/should-not-match.zip' } },
        },
      ],
    }
    expect(extractArchiveFileOutputPaths(plan)).toEqual([])
  })

  it('deduplicates the same output_path seen via more than one plan section', () => {
    // Constructed: a real plan puts a resolved archive_file in prior_state
    // OR resource_changes depending on whether it changed (see
    // plan-build-artifacts.mjs's header), never observed appearing in both
    // for the one resource in the fixtures above -- this proves the merge
    // doesn't double-report if a future Terraform version ever does.
    const plan = {
      prior_state: {
        values: {
          root_module: {
            resources: [
              { mode: 'data', type: 'archive_file', values: { output_path: './.build/a.zip' } },
            ],
          },
        },
      },
      resource_changes: [
        {
          mode: 'data',
          type: 'archive_file',
          change: { actions: ['read'], after: { output_path: './.build/a.zip' } },
        },
      ],
    }
    expect(extractArchiveFileOutputPaths(plan)).toEqual(['./.build/a.zip'])
  })

  it('handles an archive_file nested two modules deep', () => {
    // Constructed: proves the recursive child_modules walk, which the real
    // fixtures only exercise one level deep.
    const plan = {
      planned_values: {
        root_module: {
          child_modules: [
            {
              address: 'module.outer',
              child_modules: [
                {
                  address: 'module.outer.module.inner',
                  resources: [
                    {
                      mode: 'data',
                      type: 'archive_file',
                      values: { output_path: '../../../modules/inner/build/inner.zip' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    }
    expect(extractArchiveFileOutputPaths(plan)).toEqual(['../../../modules/inner/build/inner.zip'])
  })

  it('does not report an apply-deferred archive_file (output_path unknown at plan time)', () => {
    // Constructed: a data source whose inputs depend on a not-yet-created
    // resource is deferred to apply and appears with after_unknown rather
    // than a resolved after.output_path -- nothing was written to disk for
    // it at plan time, so there is nothing to report.
    const plan = {
      resource_changes: [
        {
          mode: 'data',
          type: 'archive_file',
          change: { actions: ['read'], after: null, after_unknown: { output_path: true } },
        },
      ],
    }
    expect(extractArchiveFileOutputPaths(plan)).toEqual([])
  })

  it('returns nothing for an empty plan', () => {
    expect(extractArchiveFileOutputPaths({})).toEqual([])
  })
})
