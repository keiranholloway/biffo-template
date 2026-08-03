import { packagedScriptCommand } from '../lib/packaged-script-command.js'

/**
 * `verify`, shipped in the package rather than copied into every repo (#1109).
 *
 * 978 lines that existed 15 times over, and the single largest reason the
 * shared set existed at all: eight repos once ran a gate two versions old, and
 * `tabsii-crm` checked **one** thing in eight on a 700-line change and printed
 * `verify passed` (#855). With one canonical copy inside the package, which
 * version a repo runs is simply its `.biffo-shared-version` -- there is nothing
 * left to drift.
 *
 * Safe to reach through the bridge because both call sites already have a Node
 * toolchain: `.githooks/pre-push` (which has invoked the bridge since #1109
 * phase 0d) and the `verify` script in package.json. That check is not
 * incidental -- routing the dependency audits the same way exited 127 in a CI
 * job that installs Python and never runs pnpm.
 */
export const verifyCommand = packagedScriptCommand({
  name: 'verify',
  script: 'scripts/verify.sh',
  description: 'Run the checks CI runs, before the push',
})
