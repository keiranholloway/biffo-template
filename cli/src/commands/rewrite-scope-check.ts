import { packagedScriptCommand } from '../lib/packaged-script-command.js'

/**
 * `rewrite-scope-check`, shipped in the package rather than copied into every
 * repo (#1109).
 *
 * A force-push can quietly add a file to a branch's change set and record a
 * stale copy of somebody else's merged work as your own. That happened
 * (tabsii-platform#446) and every local gate was green on it.
 *
 * `.githooks/pre-push` used to guard the call with `[ -f … ]` and warn-and-
 * continue when the script was absent — a fail-open in a gate whose entire job
 * is refusing a push. It now runs through the bridge and fails closed.
 */
export const rewriteScopeCheckCommand = packagedScriptCommand({
  name: 'rewrite-scope-check',
  script: 'scripts/rewrite-scope-check.sh',
  description: 'Refuse a push whose rewrite scope absorbs merged work from another branch',
})
