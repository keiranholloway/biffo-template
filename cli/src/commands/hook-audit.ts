import { packagedScriptCommand } from '../lib/packaged-script-command.js'

/**
 * `hook-audit`, shipped in the package rather than copied into every repo (#1109).
 *
 * AGENTS.md worktree discipline depends on it: core.hooksPath used to be relative and gitignored, so a fresh worktree silently had NO hooks and every PR built there shipped unguarded (#845).
 */
export const hookAuditCommand = packagedScriptCommand({
  name: 'hook-audit',
  script: 'scripts/hook-audit.sh',
  description: 'Report whether git hooks will actually fire in every working tree',
})
