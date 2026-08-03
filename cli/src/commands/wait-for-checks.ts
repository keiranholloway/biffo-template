import { packagedScriptCommand } from '../lib/packaged-script-command.js'

/**
 * `wait-for-checks`, shipped in the package rather than copied into every repo
 * (#1109) — the first guard to make that move, and the proof the mechanism
 * works: the published tarball carries the script, all 14 satellites resolve it
 * through `scripts/biffo.sh`, and deleting a satellite's local copy left it
 * still working, because npx installs into `~/.npm/_npx` where the resolver's
 * upward walk can never reach the repo's own `scripts/`.
 *
 * AGENTS.md §5 mandates it before any merge. It exists because a hand-rolled
 * `until … grep -c pending … done` polls for the ABSENCE of pending checks, so
 * the empty window right after `gh pr update-branch` reads as "all green" and
 * merges a PR whose CI has not started.
 */
export const waitForChecksCommand = packagedScriptCommand({
  name: 'wait-for-checks',
  script: 'scripts/wait-for-checks.sh',
  description:
    'Wait for a PR’s required checks on a positive signal (0 green, 1 failed, 2 cannot tell)',
  argument: { name: 'pr', description: 'Pull request number' },
})
