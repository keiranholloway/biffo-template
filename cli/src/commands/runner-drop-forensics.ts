import { packagedScriptCommand } from '../lib/packaged-script-command.js'

/**
 * `runner-drop-forensics`, shipped in the package rather than left reachable
 * only from a `biffo-template` checkout (#1240).
 *
 * `scripts/runner-drop-forensics.mjs` (#1238) joins a failed run's self-hosted
 * jobs against CloudTrail's spot-eviction record and says whether a red check
 * was a fleet fault or a real failure. Of the 22 runner-killed jobs it was
 * validated against, 17 were in satellites — `tabsii-platform` alone had 10 —
 * and only 5 were in repos that carry the script. Diagnosing a satellite's red
 * check needed a `biffo-template` checkout until now.
 *
 * It was left out of #1238 because `packagedScriptCommand` spawned everything
 * with `sh`, which cannot run a `.mjs`. Teaching the factory to dispatch on
 * extension (this file's counterpart change in `packaged-script-command.ts`)
 * is the fix; this is that mechanism's first `.mjs` consumer.
 *
 * Needs AWS CloudTrail read access for the account owning the fleet, so it is
 * a workstation diagnostic rather than something CI runs unattended.
 */
export const runnerDropForensicsCommand = packagedScriptCommand({
  name: 'runner-drop-forensics',
  script: 'scripts/runner-drop-forensics.mjs',
  description:
    'Decide whether a red check was a fleet fault or a real failure (0 explained, 1 real failure, 2 cannot tell)',
})
