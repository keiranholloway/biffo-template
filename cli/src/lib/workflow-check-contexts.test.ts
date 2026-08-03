import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findSkeletonRoot } from './plugin-scaffold.js'
import { workflowCheckContexts } from './workflow-check-contexts.js'

const SKELETON = findSkeletonRoot(new URL('.', import.meta.url).pathname, 'plugin-template')

describe('workflowCheckContexts', () => {
  it('uses a job name when present', () => {
    expect(
      workflowCheckContexts(`name: CI
on: [push]
jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
`),
    ).toEqual(['Lint'])
  })

  it('falls back to the job id when the job has no name', () => {
    // GitHub reports the job id as the context in that case, so protection
    // naming "build" is correct here and naming nothing would be wrong.
    expect(
      workflowCheckContexts(`jobs:
  build:
    runs-on: ubuntu-latest
`),
    ).toEqual(['build'])
  })

  it('reads several jobs in file order', () => {
    expect(
      workflowCheckContexts(`jobs:
  a:
    name: First
    runs-on: x
  b:
    name: Second
    runs-on: x
  c:
    runs-on: x
`),
    ).toEqual(['First', 'Second', 'c'])
  })

  it('ignores a step name, which is not a check context', () => {
    // The trap: steps have `name:` too, and picking one up would require a
    // check GitHub never reports, blocking every PR on a green branch.
    expect(
      workflowCheckContexts(`jobs:
  test:
    name: Test
    runs-on: x
    steps:
      - name: Install deps
        run: npm ci
      - name: Run tests
        run: npm test
`),
    ).toEqual(['Test'])
  })

  it('takes the job name even when a step name appears first in a nameless job', () => {
    expect(
      workflowCheckContexts(`jobs:
  test:
    runs-on: x
    steps:
      - name: Install deps
        run: npm ci
`),
    ).toEqual(['test'])
  })

  it('handles quoted names and trailing comments', () => {
    expect(
      workflowCheckContexts(`jobs:
  a:
    name: "Quoted Name"
  b:
    name: 'Single Quoted'
  c: # a comment
    name: Plain
`),
    ).toEqual(['Quoted Name', 'Single Quoted', 'Plain'])
  })

  it('stops at the end of the jobs block', () => {
    expect(
      workflowCheckContexts(`jobs:
  a:
    name: First
permissions:
  contents: read
`),
    ).toEqual(['First'])
  })

  it('returns nothing when there is no jobs block, so callers can tell', () => {
    // Callers must read [] as "could not determine", never as "no checks
    // required" — requiring nothing would silently unprotect the branch.
    expect(workflowCheckContexts('name: CI\non: [push]\n')).toEqual([])
    expect(workflowCheckContexts('')).toEqual([])
  })
})

describe.runIf(SKELETON)('against the real plugin skeleton', () => {
  it('extracts exactly the contexts the skeleton CI reports', () => {
    // Pinned against the real file: a reformat that defeats the parser fails
    // here rather than configuring a repo to require checks that never arrive.
    // These names are also observable on the live plugin repos scaffolded from
    // this skeleton (e.g. biffo-plugin-idea-scout's PR checks).
    const ci = readFileSync(join(SKELETON!, '.github/workflows/ci.yml'), 'utf8')

    expect(workflowCheckContexts(ci)).toEqual([
      'Lint',
      'Type Check',
      'Test',
      'Validate biffo.plugin.json',
      // #1244. The skeleton ships a terraform/ module and, until now, nothing
      // that looked at it. Adding the job adds a required context, which is the
      // point: a scaffolded plugin repo cannot merge unparseable HCL.
      'Terraform (fmt)',
      'Secret Scan',
      'Dependency Audit',
    ])
  })

  it('finds contexts in every workflow the skeleton ships', () => {
    for (const wf of ['ci.yml', 'release.yml', 'publish-registry.yml']) {
      const contexts = workflowCheckContexts(
        readFileSync(join(SKELETON!, '.github/workflows', wf), 'utf8'),
      )
      expect(contexts.length, `${wf} yielded no job contexts`).toBeGreaterThan(0)
    }
  })
})
