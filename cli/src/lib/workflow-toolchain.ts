/**
 * A workflow step must not invoke a tool its own job never installs.
 *
 * ## Why this exists
 *
 * `deploy-app.yml` shipped a bare `python -m compileall` in three jobs. None of
 * them runs `actions/setup-python`; they install uv with `python-version:
 * '3.13'`, which puts **no `python` on PATH**. The self-hosted runners carry
 * `python3` only, so the step died with `python: command not found`, exit 127 —
 * after a successful build, and after the core version had been resolved and
 * baked in. `workflow-python-interpreter.test.ts` was written to stop that
 * recurring, and it does: for `python`, in that one file.
 *
 * That is an instance guard. The class is **a step invoking a tool the job has
 * not provided**, and `python` is one member of it. `pnpm`, `uv` and
 * `terraform` are all absent from a bare runner too, all installed by an action
 * that a new job can simply forget, and all fail the same way — at run time,
 * mid-job, exit 127, after the steps before them have already done real work.
 * Nothing generalised the check, so every other member of the class was
 * unguarded and would have been found the same way: by a red deploy.
 *
 * A guard that asserts one instance is fixed catches nothing new. This
 * enumerates every job in every workflow — this repo's and the skeletons' — and
 * asserts the property for all of them, so the next member is caught before it
 * merges rather than on somebody's deploy.
 *
 * ## Why an explicit list rather than "every command needs a setup step"
 *
 * Same reasoning as `destructive-plan.mjs`: a guard that fires on everything
 * gets suppressed by reflex and then protects nothing. Most commands a workflow
 * runs — `node`, `npm`, `npx`, `aws`, `git`, `jq`, `curl`, `sh` — are present on
 * every runner this estate uses, and requiring a setup step for them would be
 * wrong as well as noisy. `deploy-infra.yml` deliberately runs the
 * destructive-plan guard on bare `node` in a job that installs nothing, and that
 * is correct and has worked in production; a guard that flagged it would be
 * reporting a defect that does not exist.
 *
 * So {@link TOOLCHAIN_REQUIREMENTS} is a small, evidence-backed list of the
 * tools that genuinely are **not** on these runners. Adding a row is a claim
 * about the runner image, so make it having checked, not by analogy.
 *
 * `python` is the sharpest case and the reason the class was visible at all: it
 * is not merely un-set-up here, it is *absent by construction*. `setup-uv`'s
 * `python-version:` installs an interpreter for uv's own use without putting
 * `python` on PATH, and the runners carry `python3` only. It survived for as
 * long as it did because GitHub-hosted images ship `python-is-python3`, so the
 * bug arrived with the move to self-hosted runners — which is also why the fix
 * has to be asserted in the repo that *authors* the workflow rather than the one
 * that runs it.
 *
 * ## Why it is not a YAML parser
 *
 * Same argument, and deliberately the same shape, as `workflow-check-contexts.ts`
 * and `workflow-run-commands.ts`: the CLI has no YAML dependency, and these are
 * workflows this repo itself owns rather than arbitrary user input. It reads the
 * narrow structure GitHub Actions mandates — a top-level `jobs:` mapping, a
 * `steps:` sequence, `uses:` and `run:` within a step — and the test pins it
 * against every real shipped workflow, so a reformat that defeats the parse
 * fails a test rather than silently emptying the guard.
 *
 * The failure direction is closed deliberately: an unparseable job yields no
 * steps and therefore no findings, so {@link parseWorkflowJobs} returning `[]`
 * must be read by callers as "could not determine" rather than "nothing to
 * check" — which is what the test asserts against the real files, and why it
 * counts jobs as well as findings.
 */

/** A tool this estate's runners do not carry unless a step installs it. */
export interface ToolchainRequirement {
  /** The command as invoked, matched against the leading token of a command. */
  tool: string
  /** `uses:` prefixes that install it. Matched by prefix, so versions float. */
  providedByActions: string[]
  /** Commands that install it inline, e.g. `corepack enable` for pnpm. */
  providedByCommands: RegExp[]
  /** Named in the failure message, so the fix is in the error rather than looked up. */
  fix: string
}

/**
 * The tools that are absent from a bare runner in this estate.
 *
 * Deliberately short. Everything omitted is a claim that the runner provides it
 * — `node`, `npm`, `npx`, `aws`, `git`, `jq`, `curl`, `sh`, `python3` — and
 * those claims are load-bearing for real jobs today (see the module docblock on
 * `deploy-infra.yml`'s bare `node`).
 */
export const TOOLCHAIN_REQUIREMENTS: ToolchainRequirement[] = [
  {
    tool: 'pnpm',
    providedByActions: ['pnpm/action-setup'],
    // `corepack enable` is the other supported route, and `npm i -g pnpm` is
    // what a job reaches for when it has node but no action.
    providedByCommands: [
      /\bcorepack\s+enable\b/,
      /\bnpm\s+(?:i|install)\s+(?:-g|--global)\s+pnpm\b/,
    ],
    fix: 'add `- uses: pnpm/action-setup@v4` to this job before the step that runs it',
  },
  {
    tool: 'uv',
    providedByActions: ['astral-sh/setup-uv'],
    providedByCommands: [/astral\.sh\/uv\/install\.sh/, /\bpipx\s+install\s+uv\b/],
    fix: 'add `- uses: astral-sh/setup-uv@v6` to this job before the step that runs it',
  },
  {
    tool: 'uvx',
    providedByActions: ['astral-sh/setup-uv'],
    providedByCommands: [/astral\.sh\/uv\/install\.sh/, /\bpipx\s+install\s+uv\b/],
    fix: 'add `- uses: astral-sh/setup-uv@v6` to this job before the step that runs it',
  },
  {
    tool: 'terraform',
    providedByActions: ['hashicorp/setup-terraform'],
    providedByCommands: [],
    fix: 'add `- uses: hashicorp/setup-terraform@v4` to this job before the step that runs it',
  },
  {
    tool: 'python',
    // Nothing in this estate uses setup-python, so in practice every bare
    // `python` is a finding. The action is listed rather than the rule being
    // "never" because a job that genuinely needs a `python` on PATH has one
    // correct way to get it, and the message should name it.
    providedByActions: ['actions/setup-python'],
    providedByCommands: [],
    fix:
      'use `python3` — the runners carry no `python`, and `setup-uv`’s ' +
      '`python-version:` does not put one on PATH. If a real `python` is needed, ' +
      'add `- uses: actions/setup-python@v5`',
  },
]

/** One `- ` entry under a job's `steps:`. */
export interface WorkflowStep {
  /** The action reference, e.g. `pnpm/action-setup@v4`, when the step is a `uses:`. */
  uses: string | null
  /** Command lines this step runs, in order, one per line of a `run:`. */
  runLines: string[]
  /** 1-based line of the step's first line, for the failure message. */
  line: number
}

export interface WorkflowJob {
  id: string
  steps: WorkflowStep[]
  /**
   * True for a job that calls a reusable workflow (`uses:` at job level). Such
   * a job has no `steps:` of its own and nothing here can see inside it, so it
   * is skipped rather than reported as clean.
   */
  reusable: boolean
}

/** True for a line that is blank or a whole-line YAML comment. */
function isSkippable(line: string): boolean {
  return line.trim() === '' || /^\s*#/.test(line)
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/**
 * Strip a heredoc body from a run block.
 *
 * A `run: |` step may contain `cat <<'EOF' > file` followed by arbitrary text,
 * and that text is data rather than commands. Without this, a config file whose
 * first word happened to be `terraform` would be read as an invocation — a
 * false positive in a guard whose whole value is that it is trusted.
 */
function stripHeredocs(lines: string[]): string[] {
  const kept: string[] = []
  let delimiter: string | null = null

  for (const line of lines) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null
      continue
    }
    // `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`
    const opened = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    kept.push(line)
    if (opened?.[2] !== undefined) delimiter = opened[2]
  }

  return kept
}

/**
 * Jobs declared by `workflow`, in file order, each with its steps.
 *
 * Returns `[]` when no `jobs:` block is found, which callers must treat as
 * "could not determine" rather than "no jobs" — the same contract
 * `workflowCheckContexts` and `workflowRunCommands` use.
 */
export function parseWorkflowJobs(workflow: string): WorkflowJob[] {
  const lines = workflow.split('\n')
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line))
  if (jobsIndex === -1) return []

  const jobs: WorkflowJob[] = []
  let jobIndent: number | null = null
  let current: WorkflowJob | null = null
  let inSteps = false
  let stepIndent: number | null = null

  for (let i = jobsIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined) continue
    if (isSkippable(line)) continue

    const indent = indentOf(line)

    // A non-indented key ends the `jobs:` mapping.
    if (indent === 0) break

    // A job id: the shallowest key under `jobs:`.
    if (jobIndent === null || indent === jobIndent) {
      const job = /^\s*([A-Za-z_][A-Za-z0-9_-]*):\s*(#.*)?$/.exec(line)
      if (job?.[1] !== undefined) {
        jobIndent = indent
        current = { id: job[1], steps: [], reusable: false }
        jobs.push(current)
        inSteps = false
        stepIndent = null
        continue
      }
    }

    if (current === null) continue

    // Job-level `uses:` — a reusable workflow call, which has no steps.
    if (!inSteps && jobIndent !== null && indent === jobIndent + 2 && /^\s*uses:\s*\S/.test(line)) {
      current.reusable = true
      continue
    }

    if (!inSteps && /^\s*steps:\s*(#.*)?$/.test(line)) {
      inSteps = true
      continue
    }

    if (!inSteps) continue

    // Leaving `steps:` for another job-level key (`env:`, `outputs:`).
    if (jobIndent !== null && indent <= jobIndent + 1) {
      inSteps = false
      stepIndent = null
      continue
    }

    const isItem = /^\s*-\s/.test(line)
    if (isItem && (stepIndent === null || indent === stepIndent)) {
      stepIndent = indent
      current.steps.push({ uses: null, runLines: [], line: i + 1 })
    }

    const step = current.steps[current.steps.length - 1]
    if (step === undefined) continue

    const uses = /^\s*-?\s*uses:\s*(\S+)/.exec(line)
    if (uses?.[1] !== undefined) {
      step.uses = uses[1]
      continue
    }

    // Inline form: `run: pnpm install`
    const inline = /^\s*-?\s*run:\s*(?!\|)(?!>)(\S.*?)\s*$/.exec(line)
    if (inline?.[1] !== undefined) {
      step.runLines.push(inline[1])
      continue
    }

    // Literal block: `run: |` (also `|-`, `|+`). Folded (`>`) is deliberately
    // not handled — line breaks fold into spaces there, so splitting per line
    // would invent commands that are not run.
    const block = /^\s*-?\s*run:\s*\|[-+]?\s*(#.*)?$/.exec(line)
    if (block !== null) {
      const keyIndent = indent
      const body: string[] = []
      for (let j = i + 1; j < lines.length; j += 1) {
        const bodyLine = lines[j]
        if (bodyLine === undefined) break
        if (bodyLine.trim() === '') continue
        if (indentOf(bodyLine) <= keyIndent) break
        body.push(bodyLine.trim())
        i = j
      }
      step.runLines.push(...stripHeredocs(body).filter((l) => !l.startsWith('#')))
    }
  }

  return jobs
}

/**
 * The tools a command line invokes.
 *
 * Splits on shell separators and takes the leading token of each segment, so a
 * tool named inside a string or an argument is not mistaken for an invocation —
 * `echo "pnpm install"` invokes `echo`. Leading environment assignments and
 * `sudo` are stripped, since `CI=1 pnpm test` does run pnpm.
 *
 * Command substitution (`$(pnpm bin)`) is deliberately not handled: it is rare
 * in these workflows, and inventing an invocation is worse than missing one in a
 * guard whose value depends on being believed.
 */
export function invokedTools(command: string): string[] {
  const tools: string[] = []

  for (const rawSegment of command.split(/&&|\|\||[;|]/)) {
    let segment = rawSegment.trim()
    // `then`, `do`, `else` etc. prefix a real command on the same line.
    segment = segment.replace(/^(?:if|then|else|elif|do|while|until|!)\s+/, '')
    // Leading environment assignments, then sudo.
    segment = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
    segment = segment.replace(/^sudo\s+/, '')

    const token = /^([A-Za-z0-9_.\-/]+)/.exec(segment)?.[1]
    if (token === undefined) continue
    // A path invocation (`./scripts/x.sh`) is not one of the bare tools here.
    if (token.includes('/')) continue
    tools.push(token)
  }

  return tools
}

export interface ToolchainFinding {
  job: string
  tool: string
  /** 1-based line of the step that invokes it. */
  line: number
  command: string
  /** True when the job provides the tool, but only after the step that uses it. */
  orderedWrong: boolean
  fix: string
}

function providesTool(step: WorkflowStep, requirement: ToolchainRequirement): boolean {
  if (
    step.uses !== null &&
    requirement.providedByActions.some((action) => step.uses?.startsWith(action))
  ) {
    return true
  }
  return step.runLines.some((line) =>
    requirement.providedByCommands.some((pattern) => pattern.test(line)),
  )
}

/**
 * Every step that invokes a tool its job has not installed by that point.
 *
 * `orderedWrong` distinguishes the two failures, because they read very
 * differently to whoever has to fix them: the tool is nowhere in the job, or it
 * is there but set up too late. The second is a real and easy mistake —
 * `actions/setup-node` with `cache: pnpm` placed above `pnpm/action-setup`
 * cannot resolve the pnpm store, so ordering is part of provision rather than a
 * stylistic preference.
 */
export function missingToolchainSetups(workflow: string): ToolchainFinding[] {
  const findings: ToolchainFinding[] = []

  for (const job of parseWorkflowJobs(workflow)) {
    if (job.reusable) continue

    for (const requirement of TOOLCHAIN_REQUIREMENTS) {
      const providedAt = job.steps.findIndex((step) => providesTool(step, requirement))

      job.steps.forEach((step, index) => {
        for (const line of step.runLines) {
          if (!invokedTools(line).includes(requirement.tool)) continue
          // Provided earlier in the job, or earlier in this same step's block.
          if (providedAt !== -1 && providedAt < index) return
          if (providedAt === index && providesEarlierInStep(step, requirement, line)) return

          findings.push({
            job: job.id,
            tool: requirement.tool,
            line: step.line,
            command: line,
            orderedWrong: providedAt !== -1,
            fix: requirement.fix,
          })
          return
        }
      })
    }
  }

  return findings
}

/** True when a `run:` block installs the tool above the line that uses it. */
function providesEarlierInStep(
  step: WorkflowStep,
  requirement: ToolchainRequirement,
  usage: string,
): boolean {
  const usageIndex = step.runLines.indexOf(usage)
  return step.runLines
    .slice(0, usageIndex)
    .some((line) => requirement.providedByCommands.some((pattern) => pattern.test(line)))
}
