import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkTerraformInput,
  checkWorkflowSource,
  findWorkflowFiles,
  stripComments,
} from './terraform-input-guard.js'

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
