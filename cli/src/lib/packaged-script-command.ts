import { spawnSync } from 'node:child_process'
import { chmodSync, statSync } from 'node:fs'
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
 * Spawns a packaged script and returns the exit code the CLI should report.
 *
 * Runs the script as a bare executable path — `spawnSync(script, args, ...)`
 * — rather than forcing a fixed interpreter, so the kernel dispatches per the
 * script's OWN shebang line. This used to hardcode `sh` for anything not
 * ending in `.mjs` (`.mjs` -> `node`, added for
 * `scripts/runner-drop-forensics.mjs`, #1240), which quietly discarded the
 * `#!/usr/bin/env bash` shebang on `branch-health.sh`, `gate-coverage.sh` and
 * `hook-audit.sh` — all three declare it because they need `set -uo
 * pipefail`. Forcing them through `sh` hands them to dash instead, and some
 * dash builds (the GitHub-hosted runner's, ubuntu-24.04) reject `set -o
 * pipefail` at RUNTIME with "Illegal option -o pipefail", exit 2 — not a
 * syntax error, so `dash -n`/`bash -n` cannot catch it, and that exit code is
 * indistinguishable from these scripts' own deliberate exit-2 ("cannot
 * tell") convention. This workstation's own dash tolerates the option, so the
 * failure is invisible locally and fires only on the real runner (#1723 —
 * the same class as #1709, one level deeper: #1709 fixed call sites in
 * `scripts/` that forced `sh scripts/<name>.sh`; this is the one factory
 * every `biffo <subcommand>` bridges through).
 *
 * Bare-exec dispatch retires the special-cased `.mjs` branch too — a `.mjs`
 * script's own `#!/usr/bin/env node` shebang does the same job the hardcoded
 * `node` branch used to. It depends on the script actually carrying the
 * executable bit (the kernel refuses to exec a file that lacks it, regardless
 * of its shebang) — restored in git for `wait-for-checks.sh` and
 * `runner-drop-forensics.mjs` alongside this change, after finding both
 * tracked as `100644`, and `sync-packaged-assets.mjs` copies via `cpSync`,
 * which preserves the source file's mode bits, so a correctly-tracked mode
 * survives into the npm-packaged copy too (verified directly: a 755 source
 * produces a 755 `cpSync` copy).
 *
 * That still leaves the bit resting on every script's git-tracked mode being
 * right forever, which is exactly the kind of thing that drifts silently —
 * `scripts/pgtest-diff-check.sh` was tracked `100644` too, missed by the
 * first pass over this factory's dispatch table, and would have failed
 * every `biffo pgtest-diff-check` invocation with an opaque `EACCES` the
 * moment this PR landed. Rather than rely on a human noticing the next one,
 * `runPackagedScript` now self-heals: it checks the script's own mode before
 * spawning and adds the executable bits if they are missing, so a future
 * script arriving without `chmod +x` (in git or on disk, including a
 * checkout that lost the bit some other way) still runs instead of failing
 * opaquely. The `chmodSync` is best-effort — a real problem (missing file,
 * unwritable filesystem) surfaces from `spawnSync` itself with a clearer
 * error than a failed pre-flight `stat` would give.
 *
 * Split out from the `Command` action so the dispatch and the exit-code
 * contract — 0/1/2 passed through unchanged, a signal-killed child
 * (`status === null`) mapped to 2 rather than reported as a pass — can be
 * tested directly against a mocked `spawnSync`, without also reproducing
 * commander's argument parsing.
 */
function ensureExecutable(script: string): void {
  try {
    const { mode } = statSync(script)
    if ((mode & 0o111) === 0) chmodSync(script, mode | 0o755)
  } catch {
    // Best-effort. A real problem here (missing file, permission denied)
    // will surface from the spawnSync call below with a clearer signal.
  }
}

export function runPackagedScript(script: string, args: string[], cwd: string): number {
  ensureExecutable(script)
  const result = spawnSync(script, args, { stdio: 'inherit', cwd })
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
