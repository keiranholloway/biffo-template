import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { findPackagedScript, packagedScriptMissing } from '../lib/packaged-scripts.js'

const SCRIPT = 'scripts/wait-for-checks.sh'

/**
 * `wait-for-checks`, as a CLI subcommand rather than a file copied into every
 * repo (#1109).
 *
 * ## Why this one first
 *
 * It is the smallest honest proof that the versioned path works for satellites.
 * It is invoked by **agents, not CI** — AGENTS.md §5 mandates it before any
 * merge — so moving it has no blast radius on a pipeline. It needs only `gh`,
 * which every repo already has. And it is 238 lines of shell that currently
 * exists 15 times over.
 *
 * ## Why it execs the script rather than porting it to TypeScript
 *
 * Porting would be a rewrite of working, load-bearing logic whose failure mode
 * is subtle: `wait-for-checks.sh` exists because hand-rolled poll loops wait
 * for the ABSENCE of pending checks, which reads the empty window right after
 * `gh pr update-branch` as "all green" and merges a PR whose CI has not
 * started. Rewriting that to prove a distribution point would be trading a real
 * risk for a presentational one.
 *
 * The goal is **one canonical copy**, not "written in TypeScript". Shipping the
 * script inside the versioned package achieves that: satellites stop holding
 * their own, and the version they run is pinned to their
 * `.biffo-shared-version` exactly as an instance's guards are pinned to its
 * `biffo.core.json`.
 *
 * ## Exit codes are passed through unchanged
 *
 * `0` green · `1` failed · `2` cannot tell. Exit 2 is never a pass, and
 * callers depend on that distinction — collapsing it here would make the
 * wrapper a fail-open in front of a script written to avoid exactly that.
 */
export const waitForChecksCommand = new Command('wait-for-checks')
  .description(
    'Wait for a PR’s required checks on a positive signal (0 green, 1 failed, 2 cannot tell)',
  )
  .argument('<pr>', 'Pull request number')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(() => {
    const here = dirname(fileURLToPath(import.meta.url))
    const script = findPackagedScript(here, SCRIPT)
    if (!script) {
      process.stderr.write(`${packagedScriptMissing(SCRIPT)}\n`)
      process.exit(2)
    }

    // Raw argv after the subcommand, not commander's parsing: the script takes
    // `-R owner/repo` and other flags positionally, and re-declaring them here
    // would be a second parser to keep in step with that one — the same reason
    // `check.ts` uses rawArgsAfter().
    const at = process.argv.indexOf('wait-for-checks')
    const args = at === -1 ? [] : process.argv.slice(at + 1)

    const result = spawnSync('sh', [script, ...args], { stdio: 'inherit' })
    // A signal-terminated child has a null status. Reporting 0 there would be a
    // pass earned by being killed.
    process.exit(result.status === null ? 2 : result.status)
  })
