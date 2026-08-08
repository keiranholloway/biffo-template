import { packagedScriptCommand } from '../lib/packaged-script-command.js'

/**
 * `pgtest-diff-check`, shipped in the package rather than copied into every
 * repo (#1109).
 *
 * `.githooks/pre-push` runs it with the same ref list it feeds
 * `rewrite-scope-check` on stdin, to decide whether a push that leaves the
 * real-Postgres lane `APPLICABLE BUT NOT RUN` (verify.sh) should be escalated
 * from an amber warning into a block (tabsii-platform#656).
 */
export const pgtestDiffCheckCommand = packagedScriptCommand({
  name: 'pgtest-diff-check',
  script: 'scripts/pgtest-diff-check.sh',
  description: 'Report whether the push touches db/imports/** or a *_pg.py module',
})
