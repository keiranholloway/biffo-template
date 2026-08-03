import { packagedScriptCommand } from '../lib/packaged-script-command.js'

/**
 * `branch-health`, shipped in the package rather than copied into every repo
 * (#1109). AGENTS.md §6 mandates it after a merge: it reports the latest run of
 * EVERY workflow on the integration branch, so the deploy cannot fall off the
 * bottom of a short `gh run list`, and it names the FIRST failing commit rather
 * than the newest — because a red deploy has no audience, the author who broke
 * it having already moved on. That cost 2h25m on 2026-08-02, with four people
 * each diagnosing their own innocent change.
 */
export const branchHealthCommand = packagedScriptCommand({
  name: 'branch-health',
  script: 'scripts/branch-health.sh',
  description: 'Report every workflow on the integration branch (0 green, 1 red, 2 cannot tell)',
})
