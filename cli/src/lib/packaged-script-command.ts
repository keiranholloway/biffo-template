import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { findPackagedScript, packagedScriptMissing } from './packaged-scripts.js'

/**
 * Builds a subcommand that runs a shell script shipped inside this package.
 *
 * ## Why a factory rather than one file per script
 *
 * This is the mechanism that retires copy-based distribution (#1109), so
 * writing it out once per script would reproduce the exact defect it exists to
 * remove — three near-identical files drifting apart, one fixed and the others
 * not. That is `_extract_detail` (#1107), written twice in two siblings for the
 * same bug, at a smaller scale.
 *
 * ## Why these execute the script instead of porting it to TypeScript
 *
 * The goal is **one canonical copy**, not "rewritten in TypeScript". These
 * scripts are load-bearing and their failure modes are subtle —
 * `wait-for-checks.sh` exists because hand-rolled poll loops wait for the
 * ABSENCE of pending checks and merge a PR whose CI has not started; `claim.sh`
 * asks four independent questions because three of four real collisions were
 * "work exists, label does not". Rewriting working logic to prove a
 * distribution point would trade a real risk for a presentational one.
 *
 * ## Exit codes pass through unchanged
 *
 * Every script here uses the estate's three-valued contract: `0` green, `1`
 * failed, `2` cannot tell — and **2 is never a pass**. Collapsing it would make
 * this wrapper a fail-open in front of scripts written to avoid exactly that.
 * (`scripts/biffo.sh` had this bug: `pnpm exec` normalises every non-zero exit
 * to 1.)
 */

/**
 * Picks the interpreter a packaged script runs under, from its extension.
 *
 * `.sh` -> `sh`, unchanged since this factory's first script — six commands
 * depend on that today and none of them may see a different interpreter.
 * `.mjs` -> `node`, added for `scripts/runner-drop-forensics.mjs` (#1240): a
 * `.mjs` cannot go through `sh` unmodified, and #1238 rejected rewriting its
 * JSON-shaped CloudTrail-matching logic in shell to avoid that — the same
 * "rewriting working logic to prove a distribution point" trade this file's
 * own docstring already argues against.
 */
export function interpreterFor(script: string): string {
  return script.endsWith('.mjs') ? 'node' : 'sh'
}

/**
 * Spawns a packaged script and returns the exit code the CLI should report.
 *
 * Split out from the `Command` action so the interpreter dispatch and the
 * exit-code contract — 0/1/2 passed through unchanged, a signal-killed child
 * (`status === null`) mapped to 2 rather than reported as a pass — can be
 * tested directly against a mocked `spawnSync`, without also reproducing
 * commander's argument parsing.
 */
export function runPackagedScript(script: string, args: string[], cwd: string): number {
  const result = spawnSync(interpreterFor(script), [script, ...args], { stdio: 'inherit', cwd })
  // A signal-terminated child has a null status. Reporting 0 there would be a
  // pass earned by being killed.
  return result.status === null ? 2 : result.status
}

export function packagedScriptCommand(spec: {
  name: string
  script: string
  description: string
  argument?: { name: string; description: string }
}): Command {
  const command = new Command(spec.name)
    .description(spec.description)
    // Raw argv is forwarded, so commander must not reject or reinterpret the
    // flags the scripts define themselves. Re-declaring them here would be a
    // second parser to keep in step with the first.
    .allowExcessArguments(true)
    .allowUnknownOption(true)

  if (spec.argument) command.argument(`<${spec.argument.name}>`, spec.argument.description)

  return command.action(() => {
    const here = dirname(fileURLToPath(import.meta.url))
    const script = findPackagedScript(here, spec.script)
    if (!script) {
      process.stderr.write(`${packagedScriptMissing(spec.script)}\n`)
      process.exit(2)
    }

    const at = process.argv.indexOf(spec.name)
    const args = at === -1 ? [] : process.argv.slice(at + 1)

    // Back in the directory the caller stood in, not the repo root that
    // `scripts/biffo.sh` normalises to. Scripts that take their target from the
    // working directory (the dependency audits, invoked from a CI job's
    // `working-directory:`) would otherwise audit the wrong tree and pass.
    const cwd = process.env['BIFFO_ORIGINAL_CWD'] || process.cwd()
    process.exit(runPackagedScript(script, args, cwd))
  })
}
