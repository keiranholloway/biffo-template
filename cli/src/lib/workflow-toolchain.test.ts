import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  TOOLCHAIN_REQUIREMENTS,
  invokedTools,
  missingToolchainSetups,
  parseWorkflowJobs,
} from './workflow-toolchain.js'

// cli/src/lib/ -> cli/src/ -> cli/ -> repo root
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Every workflow this repo authors: its own, and the skeletons'.
 *
 * The skeletons matter more than this repo's own files, not less. A defect in
 * `_skeletons/sibling-template/.github/workflows/ci.yml` is a defect every repo
 * created afterwards is *born* with, and the repo that runs it is not the repo
 * that can fix it — the same argument `workflow-python-interpreter.test.ts` and
 * `workflow-relative-paths.test.ts` make for living here.
 */
function workflowFiles(): string[] {
  const roots = [
    join(repoRoot, '.github/workflows'),
    ...readdirSync(join(repoRoot, '_skeletons'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoRoot, '_skeletons', entry.name, '.github/workflows')),
  ]

  return roots
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
        .map((name) => join(dir, name)),
    )
}

describe('invokedTools', () => {
  it('reads the leading token of each command segment', () => {
    expect(invokedTools('pnpm install --frozen-lockfile')).toContain('pnpm')
    expect(invokedTools('cd cli && pnpm build')).toContain('pnpm')
    expect(invokedTools('CI=1 FORCE_COLOR=0 pnpm test')).toContain('pnpm')
    expect(invokedTools('sudo terraform apply')).toContain('terraform')
  })

  it('does not mistake a tool named inside an argument for an invocation', () => {
    // The false positive that would make this guard untrustworthy: a guard
    // firing on prose gets suppressed, and then it protects nothing.
    expect(invokedTools('echo "run pnpm install first"')).not.toContain('pnpm')
    expect(invokedTools('grep -r terraform .')).not.toContain('terraform')
    expect(invokedTools('sh scripts/py-dependency-audit.sh')).not.toContain('uv')
  })

  it('does not treat a path invocation as a bare tool', () => {
    expect(invokedTools('./scripts/terraform')).not.toContain('terraform')
  })
})

describe('parseWorkflowJobs', () => {
  it('attributes steps to their own job', () => {
    const jobs = parseWorkflowJobs(
      [
        'jobs:',
        '  js:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: pnpm/action-setup@v4',
        '      - run: pnpm install',
        '  py:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: uv sync',
      ].join('\n'),
    )

    expect(jobs.map((job) => job.id)).toEqual(['js', 'py'])
    expect(jobs[0]?.steps).toHaveLength(2)
    expect(jobs[0]?.steps[0]?.uses).toBe('pnpm/action-setup@v4')
    expect(jobs[1]?.steps[0]?.runLines).toEqual(['uv sync'])
  })

  it('reads literal block scalars and drops their comments', () => {
    const jobs = parseWorkflowJobs(
      [
        'jobs:',
        '  build:',
        '    steps:',
        '      - name: Build',
        '        run: |',
        '          # install first',
        '          corepack enable',
        '          pnpm build',
        '      - run: echo done',
      ].join('\n'),
    )

    expect(jobs[0]?.steps[0]?.runLines).toEqual(['corepack enable', 'pnpm build'])
    expect(jobs[0]?.steps[1]?.runLines).toEqual(['echo done'])
  })

  it('ignores heredoc bodies, which are data rather than commands', () => {
    const jobs = parseWorkflowJobs(
      [
        'jobs:',
        '  write:',
        '    steps:',
        '      - run: |',
        "          cat <<'EOF' > notes.txt",
        '          terraform is not run here',
        '          EOF',
        '          echo written',
      ].join('\n'),
    )

    expect(jobs[0]?.steps[0]?.runLines).not.toContain('terraform is not run here')
    expect(jobs[0]?.steps[0]?.runLines).toContain('echo written')
  })

  it('marks a reusable-workflow job so it is skipped rather than reported clean', () => {
    const jobs = parseWorkflowJobs(
      ['jobs:', '  call:', '    uses: ./.github/workflows/ci.yml', '    secrets: inherit'].join(
        '\n',
      ),
    )

    expect(jobs[0]?.reusable).toBe(true)
  })

  it('returns [] for a workflow with no jobs block, meaning "could not determine"', () => {
    expect(parseWorkflowJobs('name: nothing\non: push\n')).toEqual([])
  })
})

describe('missingToolchainSetups', () => {
  it('flags a tool the job never installs', () => {
    const findings = missingToolchainSetups(
      ['jobs:', '  py:', '    steps:', '      - run: uv sync'].join('\n'),
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]?.tool).toBe('uv')
    expect(findings[0]?.job).toBe('py')
    expect(findings[0]?.orderedWrong).toBe(false)
  })

  it('accepts a tool installed by its action', () => {
    expect(
      missingToolchainSetups(
        [
          'jobs:',
          '  py:',
          '    steps:',
          '      - uses: astral-sh/setup-uv@v6',
          '      - run: uv sync',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('accepts a tool installed inline, in the same step, above its use', () => {
    expect(
      missingToolchainSetups(
        [
          'jobs:',
          '  js:',
          '    steps:',
          '      - run: |',
          '          corepack enable',
          '          pnpm install',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('flags a tool set up AFTER the step that uses it', () => {
    // `actions/setup-node` with `cache: pnpm` above `pnpm/action-setup` is the
    // real-world version of this: the cache step cannot resolve a store that
    // does not exist yet.
    const findings = missingToolchainSetups(
      [
        'jobs:',
        '  js:',
        '    steps:',
        '      - run: pnpm install',
        '      - uses: pnpm/action-setup@v4',
      ].join('\n'),
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]?.orderedWrong).toBe(true)
  })

  it('flags bare `python`, which no runner in this estate carries', () => {
    // The original instance (#414): setup-uv installs an interpreter for uv's
    // own use and puts no `python` on PATH.
    const findings = missingToolchainSetups(
      [
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: astral-sh/setup-uv@v6',
        '        with:',
        "          python-version: '3.13'",
        '      - run: python -m compileall .',
      ].join('\n'),
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]?.tool).toBe('python')
  })

  it('accepts `python3`, which they do', () => {
    expect(
      missingToolchainSetups(
        ['jobs:', '  build:', '    steps:', '      - run: python3 -m compileall .'].join('\n'),
      ),
    ).toEqual([])
  })

  it('does not flag a tool the runner provides', () => {
    // `deploy-infra.yml` runs the destructive-plan guard on bare node in a job
    // that installs nothing, deliberately and correctly.
    expect(
      missingToolchainSetups(
        ['jobs:', '  plan:', '    steps:', '      - run: node scripts/check.mjs plan.json'].join(
          '\n',
        ),
      ),
    ).toEqual([])
  })
})

describe('every shipped workflow', () => {
  const files = workflowFiles()

  /**
   * A sweep that reports zero because it read nothing is the estate's most
   * repeated defect, and it is what this guard would become if a path moved or
   * a reformat defeated the parser. These two assertions are the difference
   * between "no job invokes an uninstalled tool" and "no job was examined".
   */
  it('is actually being read', () => {
    expect(files.length).toBeGreaterThanOrEqual(10)

    const jobs = files.flatMap((file) => parseWorkflowJobs(readFileSync(file, 'utf8')))
    expect(jobs.length).toBeGreaterThanOrEqual(20)

    const withSteps = jobs.filter((job) => job.steps.length > 0)
    expect(withSteps.length).toBeGreaterThanOrEqual(20)

    // The guard is worthless if the parser stops finding commands at all, so
    // pin the tools that are genuinely invoked by the shipped workflows.
    //
    // Deliberately not every entry in TOOLCHAIN_REQUIREMENTS: `uvx` is simply
    // not used here, and `python` MUST be absent — its presence is a finding
    // rather than a sign of health, so it could never serve as a liveness
    // signal. Adding a requirement for a tool nothing invokes yet is fine and
    // should not fail this.
    const tools = new Set(
      withSteps.flatMap((job) => job.steps.flatMap((step) => step.runLines.flatMap(invokedTools))),
    )
    for (const tool of ['pnpm', 'uv', 'terraform']) {
      expect(
        tools,
        `no shipped workflow invokes ${tool} — has the parser stopped reading?`,
      ).toContain(tool)
      expect(TOOLCHAIN_REQUIREMENTS.map((r) => r.tool)).toContain(tool)
    }
  })

  it.each(files.map((file) => [relative(repoRoot, file), file]))(
    'installs every toolchain it invokes: %s',
    (_label, file) => {
      const findings = missingToolchainSetups(readFileSync(file, 'utf8'))

      const report = findings
        .map(
          (finding) =>
            `  job "${finding.job}" line ${finding.line}: \`${finding.command}\`\n` +
            `    ${finding.tool} is ${finding.orderedWrong ? 'set up AFTER this step' : 'never set up in this job'}\n` +
            `    fix: ${finding.fix}`,
        )
        .join('\n')

      expect(findings, findings.length === 0 ? '' : `\n${report}\n`).toEqual([])
    },
  )
})
