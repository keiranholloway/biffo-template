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

    const result = spawnSync('sh', [script, ...args], { stdio: 'inherit' })
    // A signal-terminated child has a null status. Reporting 0 there would be a
    // pass earned by being killed.
    process.exit(result.status === null ? 2 : result.status)
  })
}
