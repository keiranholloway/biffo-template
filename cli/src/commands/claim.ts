import { packagedScriptCommand } from '../lib/packaged-script-command.js'

/**
 * `claim`, shipped in the package rather than copied into every repo (#1109).
 * AGENTS.md §1 mandates it before starting an issue. It asks four independent
 * questions — label, open PR, remote branch, merged PR — because the answer
 * lives in more than one place: of four collisions in one morning, three were
 * "work exists, label does not", so checking the label alone would have caught
 * one of four.
 */
export const claimCommand = packagedScriptCommand({
  name: 'claim',
  script: 'scripts/claim.sh',
  description: 'Check and claim an issue before starting (0 free, 1 taken, 2 cannot tell)',
})
