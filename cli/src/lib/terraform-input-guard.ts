/**
 * Drift guard for non-interactive Terraform in CI (issue #322).
 *
 * A `terraform` subcommand that cannot resolve a required variable prompts on
 * stdin. On a GitHub Actions runner there is no stdin to answer it, so the step
 * blocks until the job is killed — observed as a 61-minute silent hang in
 * `deploy-global.yml` with no output and a generic "did not complete within 60
 * minutes" at the end. Nothing in the run indicates which step stuck, or why.
 *
 * `-auto-approve` does NOT prevent this: it suppresses the apply confirmation
 * only, not variable prompts. So an `apply` is just as exposed as the `import`
 * that actually hung.
 *
 * Workflows set `TF_INPUT: '0'` at workflow level as the real backstop, but an
 * env var is easy to drop when copying a job into a new workflow, and the
 * failure it prevents is invisible until a production deploy hangs. This guard
 * therefore enforces both halves at source level:
 *
 *   1. every mutating/config-reading invocation passes `-input=false`
 *   2. every workflow that runs Terraform at all sets `TF_INPUT`
 *
 * Deliberately a source-level check: the hang only reproduces on a runner with
 * a closed stdin and an unresolved variable, which is precisely the combination
 * no unit test can stage. See the issue — this path is reachable almost only
 * via teardown-then-redeploy, and had never once completed successfully.
 *
 * NOTE ON CORRECTNESS OF THE GUARD ITSELF: a previous guard in this repo passed
 * because it matched its own explanatory comment rather than the code it
 * checked. This one strips YAML/shell comments before scanning, and its tests
 * assert it *fails* on a known-bad fixture — a guard that can only pass proves
 * nothing.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Subcommands that evaluate configuration, and so can prompt for variables. */
export const GUARDED_SUBCOMMANDS = [
  'init',
  'plan',
  'apply',
  'destroy',
  'import',
  'refresh',
] as const

/**
 * Subcommands that never prompt for input and so need no flag. `output`,
 * `state`, `fmt` and `validate` read state or files without evaluating the
 * variable set that triggers a prompt.
 */
const IGNORED_SUBCOMMANDS = ['output', 'state', 'fmt', 'validate', 'version', 'workspace', 'show']

export interface Violation {
  file: string
  line: number
  message: string
}

/**
 * Removes YAML and shell `#` comments so prose describing `terraform apply`
 * cannot be mistaken for an invocation of it — and, symmetrically, so a real
 * invocation cannot hide behind a comment. Only `#` at line start or preceded
 * by whitespace starts a comment, which matches both YAML and POSIX shell.
 */
export function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n')
}

/** Recursively collects workflow YAML files, skipping vendored trees. */
export function findWorkflowFiles(repoRoot: string): string[] {
  const found: string[] = []

  const walk = (dir: string, relative: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === '.worktrees') continue
      const full = join(dir, entry)
      const rel = relative ? `${relative}/${entry}` : entry
      if (statSync(full).isDirectory()) {
        walk(full, rel)
      } else if (/\.ya?ml$/.test(entry) && relative.endsWith('.github/workflows')) {
        found.push(rel)
      }
    }
  }

  walk(repoRoot, '')
  return found.sort()
}

/**
 * Scans one workflow's source for Terraform invocations missing `-input=false`,
 * and for a missing workflow-level `TF_INPUT`.
 */
export function checkWorkflowSource(file: string, rawSource: string): Violation[] {
  const violations: Violation[] = []
  const source = stripComments(rawSource)
  const lines = source.split('\n')

  let sawGuardedInvocation = false

  lines.forEach((line, index) => {
    // Match `terraform <sub>` anywhere in the line: it may be a `run:` one
    // liner, or a bare command inside a block scalar.
    const match = /(?:^|[\s;&|(])terraform\s+([a-z-]+)/.exec(line)
    if (!match) return

    const subcommand = match[1]
    if (subcommand === undefined) return
    if (IGNORED_SUBCOMMANDS.includes(subcommand)) return
    if (!(GUARDED_SUBCOMMANDS as readonly string[]).includes(subcommand)) return

    sawGuardedInvocation = true

    if (!/-input=false/.test(line)) {
      violations.push({
        file,
        line: index + 1,
        message:
          `terraform ${subcommand} is missing -input=false. Without it Terraform ` +
          `prompts on stdin for any unresolved variable and blocks forever in CI ` +
          `(issue #322). Note -auto-approve does not suppress variable prompts.`,
      })
    }
  })

  if (sawGuardedInvocation && !/^\s*TF_INPUT\s*:/m.test(source)) {
    violations.push({
      file,
      line: 1,
      message:
        `workflow runs Terraform but does not set TF_INPUT. Add "TF_INPUT: '0'" ` +
        `to the workflow-level env block as a backstop (issue #322).`,
    })
  }

  return violations
}

/** Checks every workflow in the repo. Returns [] when the convention holds. */
export function checkTerraformInput(repoRoot: string): Violation[] {
  return findWorkflowFiles(repoRoot).flatMap((file) =>
    checkWorkflowSource(file, readFileSync(join(repoRoot, file), 'utf8')),
  )
}
