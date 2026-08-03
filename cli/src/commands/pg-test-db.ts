import { packagedScriptCommand } from '../lib/packaged-script-command.js'

/**
 * `pg-test-db`, shipped in the package rather than copied into every repo (#1109).
 *
 * verify.sh calls it to raise a real-Postgres lane; it is idempotent and cheap, so calling it beats warning about it.
 */
export const pgTestDbCommand = packagedScriptCommand({
  name: 'pg-test-db',
  script: 'scripts/pg-test-db.sh',
  description: 'Provision the local Postgres test database and print its DSN',
})
