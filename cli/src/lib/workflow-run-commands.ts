/**
 * The shell commands a GitHub Actions workflow actually runs (#956, #718, #720).
 *
 * ## Why this exists
 *
 * Guards that assert "CI still invokes this check" were written as substring
 * tests over the raw workflow text:
 *
 * ```ts
 * expect(workflow).toContain(`sh scripts/biffo.sh check ${name}`)
 * ```
 *
 * That asserts a *substring*, while the invariant it means is *this exact
 * command runs*. Any superset satisfies it, so renaming a guard by extension —
 * `plugin-collisions` to `plugin-collisionsXX` — leaves the assertion passing
 * over a workflow that no longer runs the guard at all. Deletion and
 * prefix-renames are caught; suffix-extension is not, and #720 found that only
 * by accident.
 *
 * Splitting the workflow into the discrete commands it runs turns the same
 * assertion into exact membership, because `expect(array).toContain(x)` compares
 * elements rather than searching text. There is nothing to tune and no way for a
 * longer name to satisfy it.
 *
 * ## Why it is not a YAML parser
 *
 * Same reasoning as `workflow-check-contexts.ts`, and deliberately the same
 * shape: the CLI has no YAML dependency, and these are workflows this repo
 * itself owns rather than arbitrary user input. It reads the narrow structure
 * GitHub Actions mandates — `run:` as an inline scalar or a literal block — and
 * `workflow-run-commands.test.ts` pins it against the real shipped workflows so
 * a reformat fails a test rather than silently emptying a guard.
 *
 * It deliberately does not handle **folded** block scalars (`run: >`), where
 * line breaks fold into spaces and splitting per line would invent commands that
 * are not run. Those are skipped rather than guessed at; no workflow in this
 * repo uses one, and `assertRunsCommand` fails loudly on a missing command, so
 * the failure direction is closed.
 */

/** True for a line that is blank or a whole-line YAML comment. */
function isSkippable(line: string): boolean {
  return line.trim() === '' || /^\s*#/.test(line)
}

/**
 * Every shell command `workflow` runs, in file order, one entry per line of a
 * `run:` step.
 *
 * Returns `[]` when the workflow contains no `run:` at all, which callers must
 * treat as "could not determine" rather than "runs nothing" — the same contract
 * `workflowCheckContexts` uses.
 */
export function workflowRunCommands(workflow: string): string[] {
  const lines = workflow.split('\n')
  const commands: string[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined) continue

    // Inline form: `run: pnpm install`
    const inline = /^(\s*)-?\s*run:\s*(?!\|)(?!>)(\S.*?)\s*$/.exec(line)
    if (inline?.[2] !== undefined) {
      commands.push(inline[2])
      continue
    }

    // Literal block: `run: |` (also `|-`, `|+`). Every subsequent line indented
    // deeper than the `run:` key is a command line of that step.
    const block = /^(\s*)-?\s*run:\s*\|[-+]?\s*(#.*)?$/.exec(line)
    if (block?.[1] === undefined) continue

    const keyIndent = line.length - line.trimStart().length
    for (let j = i + 1; j < lines.length; j += 1) {
      const body = lines[j]
      if (body === undefined) break
      if (isSkippable(body)) continue
      const indent = body.length - body.trimStart().length
      if (indent <= keyIndent) break
      commands.push(body.trim())
      i = j
    }
  }

  return commands
}

/**
 * Assert that `workflow` runs `command` exactly, and say something useful when
 * it does not.
 *
 * Prefer this over `expect(workflow).toContain(command)` in any guard whose
 * point is that a check still runs. The substring form passes for a command that
 * merely *starts with* the one you named, which is how a renamed guard stays
 * green while doing nothing.
 */
export function assertInvokes(text: string, command: string): void {
  // For call sites where arguments legitimately follow — the commit hook runs
  // `sh scripts/biffo.sh check ownership --staged "$1" || exit 1`, so exact
  // equality would be the wrong assertion. This still closes the hole
  // `toContain` leaves, by requiring the command to end at a token boundary:
  // `check ownershipXX` no longer satisfies `check ownership`.
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`${escaped}(?=\\s|$)`, 'm').test(text)) return

  const loose = text.includes(command)
  throw new Error(
    `Nothing invokes:\n  ${command}` +
      (loose
        ? '\n\nIt appears as a PREFIX of something longer, which is the failure this ' +
          'assertion exists to catch — a guard renamed by extension leaves a ' +
          '`toContain` check green while the original no longer runs.'
        : ''),
  )
}

export function assertRunsCommand(workflow: string, command: string): void {
  const commands = workflowRunCommands(workflow)
  if (commands.includes(command)) return

  const nearMiss = commands.filter((c) => c.startsWith(command) || command.startsWith(c))
  const hint =
    nearMiss.length > 0
      ? `\n\nClosest commands that DO run (note these are not equal to it — a substring assertion would have passed here):\n  ${nearMiss.join('\n  ')}`
      : commands.length === 0
        ? '\n\nThe workflow declares no `run:` steps at all, so this may be a parse failure rather than a missing command.'
        : ''

  throw new Error(`The workflow does not run:\n  ${command}${hint}`)
}
