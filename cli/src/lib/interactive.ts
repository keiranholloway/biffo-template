import type { Command } from 'commander'
import inquirer from 'inquirer'

/**
 * Non-interactive mode (issue #274).
 *
 * The CLI's value proposition is automation, so every command must be drivable
 * from CI, a script, or an agent. Historically a few commands stopped at a
 * prompt that no flag could suppress — `biffo deploy dev -y` still asked which
 * project to deploy once a second project existed in `~/.biffo/projects/`, and
 * `biffo teardown` had no way at all to pre-confirm. A script hung instead of
 * failing, which is the worst failure mode: no output, no exit code, no clue.
 *
 * `--non-interactive` is the single global answer. It does NOT answer questions
 * and it does NOT skip confirmations — it turns any would-be prompt into a hard
 * error that names the flag which supplies that answer. Safety of destructive
 * commands is therefore unchanged: without the flag, `biffo teardown` still
 * demands the typed project name.
 *
 * The mode is also settable with `BIFFO_NON_INTERACTIVE=1` for environments
 * that inject configuration by env rather than argv.
 */

export const NON_INTERACTIVE_FLAG = '--non-interactive'
export const NON_INTERACTIVE_ENV = 'BIFFO_NON_INTERACTIVE'

/**
 * Thrown in place of a prompt when non-interactive mode is on.
 *
 * Carries a fully composed, human-readable message: what was going to be asked,
 * and which flag answers it. `index.ts` catches it and exits 1.
 */
export class NonInteractiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonInteractiveError'
  }
}

/**
 * Read the flag from argv/env directly rather than from Commander's parsed
 * options. `--non-interactive` is declared on the root program and on every
 * subcommand, so it can appear on either side of the subcommand name; reading
 * argv makes every call site agree on its value without threading an option
 * through helper functions that never see the Command object.
 */
export function isNonInteractive(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const fromEnv = env[NON_INTERACTIVE_ENV]
  if (fromEnv !== undefined && fromEnv !== '' && fromEnv !== '0' && fromEnv !== 'false') {
    return true
  }
  return argv.includes(NON_INTERACTIVE_FLAG)
}

/** Compose the refusal message. Exported so tests can assert on it exactly. */
export function nonInteractiveMessage(question: string, remedy: string): string {
  return `Refusing to prompt for "${question}" — ${NON_INTERACTIVE_FLAG} is set.\n` + `  ${remedy}`
}

/**
 * Throw if a prompt would be shown in non-interactive mode.
 *
 * @param question What the user would have been asked.
 * @param remedy   How to supply the answer without a prompt, e.g.
 *                 "Pass --project <name> to choose one."
 */
export function assertInteractive(question: string, remedy: string): void {
  if (isNonInteractive()) {
    throw new NonInteractiveError(nonInteractiveMessage(question, remedy))
  }
}

/**
 * `inquirer.prompt`, guarded. Use this at every prompt site so that adding a
 * prompt cannot silently reintroduce a hang.
 */
export async function promptOr<T>(
  guard: { question: string; remedy: string },
  questions: readonly Record<string, unknown>[],
): Promise<T> {
  assertInteractive(guard.question, guard.remedy)
  // inquirer's own question type is a discriminated union its overloads resolve
  // per literal; that inference is lost through this wrapper, so widen here.
  return (await inquirer.prompt(questions as never)) as T
}

/**
 * Add `--non-interactive` to a command and, recursively, to every subcommand.
 *
 * Commander rejects unknown options on subcommands, so a truly global flag has
 * to be registered on each one. Applying it recursively from `index.ts` keeps
 * every present and future command consistent.
 */
export function registerNonInteractive(command: Command): Command {
  const already = command.options.some((o) => o.long === NON_INTERACTIVE_FLAG)
  if (!already) {
    command.option(
      NON_INTERACTIVE_FLAG,
      'Never prompt; fail with an error naming the flag that supplies the answer',
    )
  }
  for (const sub of command.commands) {
    registerNonInteractive(sub)
  }
  return command
}
