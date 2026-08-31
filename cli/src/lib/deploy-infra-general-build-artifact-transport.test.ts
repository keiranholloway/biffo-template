/**
 * `deploy-infra.yml`'s `tfbuild-<env>` upload/download of
 * `infra/environments/<env>/.build/` (the #1774 fix) transports ONE assumed
 * location. biffo-template#1772 reproduced the general case #1663 actually
 * asked for: a `data "archive_file"` declared inside a reusable Terraform
 * module, using `output_path = "${path.module}/..."`, writes OUTSIDE
 * `.build/` entirely -- this repo's own former
 * `modules/cloud/aws/compute/main.tf` did exactly that before #1457/#1460 --
 * and the fixed-directory transport never sees it, so `terraform apply`
 * fails on the apply runner with the exact "no such file or directory" the
 * whole mechanism exists to prevent.
 *
 * The fix computes the file set from the plan itself
 * (`scripts/collect-plan-build-artifacts.mjs`, tested directly in
 * `plan-build-artifacts.test.ts` / `collect-plan-build-artifacts.test.ts`)
 * instead of assuming a second directory. This file guards that the
 * workflow actually WIRES that collector into all three plan/apply job
 * pairs -- the logic being correct doesn't help if a job forgets to call it.
 *
 * Written as a plain line scan, matching
 * `workflow-hidden-artifact-upload.test.ts`'s own approach in this same
 * workflow -- no YAML parser is a dependency of the `cli` workspace.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKFLOW_PATH = join(repoRoot, '.github/workflows/deploy-infra.yml')
const ENVS = ['dev', 'staging', 'prod']

function readWorkflow(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8')
}

describe('deploy-infra.yml wires the general plan-time-build-artifact collector into every env (#1663, #1772)', () => {
  const yaml = readWorkflow()

  it.each(ENVS)(
    'plan-%s: collects other build artifacts via the plan itself, not a hardcoded path',
    (env) => {
      // The collector step must exist, invoke the script that reads plan.json
      // (not a re-derived assumption), and gate the upload on what it found.
      expect(yaml).toContain(`id: tfbuild-extra-${env}`)
      expect(yaml).toMatch(
        new RegExp(`id: tfbuild-extra-${env}[\\s\\S]{0,400}collect-plan-build-artifacts\\.mjs`),
      )
      expect(yaml).toMatch(
        new RegExp(
          `if: steps\\.tfbuild-extra-${env}\\.outputs\\.found == 'true'[\\s\\S]{0,200}name: tfbuild-extra-${env}\\b`,
        ),
      )
    },
  )

  it.each(ENVS)(
    'apply-%s: restores other build artifacts before running terraform apply',
    (env) => {
      // The download must be present, must not hard-fail when the plan had
      // nothing to transport (if-no-artifact-found: ignore), and must extract
      // BEFORE `terraform apply` runs -- otherwise the restore is a no-op.
      expect(yaml).toMatch(
        new RegExp(`name: tfbuild-extra-${env}\\b[\\s\\S]{0,120}if-no-artifact-found: ignore`),
      )
      const restoreMatch = new RegExp(
        `name: tfbuild-extra-${env}\\b[\\s\\S]*?Restore other plan-time build artifacts[\\s\\S]*?tar -xzf[\\s\\S]*?tfbuild-extra-${env}\\.tar\\.gz`,
      ).exec(yaml)
      expect(restoreMatch).not.toBeNull()
    },
  )

  it("every plan-<env> job's collector step runs before its conditional upload-artifact step (ordering)", () => {
    for (const env of ENVS) {
      const collectIdx = yaml.indexOf(`id: tfbuild-extra-${env}`)
      const uploadIdx = yaml.indexOf(`name: tfbuild-extra-${env}`, collectIdx)
      expect(collectIdx).toBeGreaterThan(-1)
      expect(uploadIdx).toBeGreaterThan(collectIdx)
    }
  })

  it('every apply-<env> job restores the extra artifact before `terraform apply -auto-approve tfplan` runs', () => {
    // A restore step after apply would be silently useless -- this pins the
    // order so a future edit can't reintroduce that.
    for (const env of ENVS) {
      const restoreIdx = yaml.indexOf(
        'Restore other plan-time build artifacts',
        yaml.indexOf(`name: tfbuild-extra-${env}`),
      )
      const applyIdx = yaml.indexOf('terraform apply -input=false -auto-approve tfplan', restoreIdx)
      expect(restoreIdx).toBeGreaterThan(-1)
      expect(applyIdx).toBeGreaterThan(restoreIdx)
    }
  })

  it('does not regress the #1774 fix: the three tfbuild-<env> .build/ uploads still set include-hidden-files: true', () => {
    // Guards against "generalised the mechanism and quietly dropped the
    // specific fix it must not regress" -- see workflow-hidden-artifact-upload.test.ts
    // for the full assertion this duplicates the spirit of. indexOf rather
    // than a bounded regex window: the real comment between `path:` and
    // `include-hidden-files:` here is long (explaining the #1774 incident in
    // full) and a short window is brittle against comment-length drift.
    for (const env of ENVS) {
      const nameIdx = yaml.indexOf(`name: tfbuild-${env}\n`)
      expect(nameIdx, `no tfbuild-${env} upload step found`).toBeGreaterThan(-1)
      const pathIdx = yaml.indexOf(`path: infra/environments/${env}/.build/`, nameIdx)
      expect(pathIdx, `no .build/ path for tfbuild-${env}`).toBeGreaterThan(nameIdx)
      const hiddenIdx = yaml.indexOf('include-hidden-files: true', pathIdx)
      // Must appear before the NEXT step starts (a `- uses:` at the same
      // indent), so a match far later in the file can't false-pass this.
      const nextStepIdx = yaml.indexOf('\n      - uses:', pathIdx)
      expect(hiddenIdx, `include-hidden-files: true missing for tfbuild-${env}`).toBeGreaterThan(
        pathIdx,
      )
      expect(hiddenIdx).toBeLessThan(nextStepIdx)
    }
  })
})

describe('fail-first proof: the ordering guard actually fires on a broken shape', () => {
  it('flags a restore step placed AFTER terraform apply', () => {
    const broken = `
      - uses: actions/download-artifact@v5
        with:
          name: tfbuild-extra-dev
      - run: terraform apply -input=false -auto-approve tfplan
      - name: Restore other plan-time build artifacts
        run: |
          tar -xzf tfbuild-extra-dev.tar.gz
`
    const restoreIdx = broken.indexOf(
      'Restore other plan-time build artifacts',
      broken.indexOf('name: tfbuild-extra-dev'),
    )
    const applyIdx = broken.indexOf('terraform apply -input=false -auto-approve tfplan', restoreIdx)
    // applyIdx is -1 (not found after restoreIdx) because apply comes first --
    // this is exactly the broken ordering the real assertion above rejects.
    expect(applyIdx).toBe(-1)
  })
})
