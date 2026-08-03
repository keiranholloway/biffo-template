import { packagedScriptCommand } from '../lib/packaged-script-command.js'

/**
 * `gate-coverage`, shipped in the package rather than copied into every repo (#1109).
 *
 * Answers what fraction of the CI checks the local gate reproduces. shared-sync runs it inside each staged worktree during rehearsal, so it must be reachable in a satellite that no longer carries a copy.
 */
export const gateCoverageCommand = packagedScriptCommand({
  name: 'gate-coverage',
  script: 'scripts/gate-coverage.sh',
  description: 'Report how much of CI the local gate actually mirrors',
})
