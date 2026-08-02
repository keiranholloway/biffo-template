/**
 * Cognito group membership, read from the ID token the browser already holds.
 *
 * Group membership is the source of truth for authorization (ADR-0004,
 * ADR-0011): the Core API reads the `cognito:groups` JWT claim into the
 * caller's roles and matches it against declarative route permissions. This
 * module is the *client-side* reading of that same claim — not a second
 * authority, and never a substitute for the API's own check. It exists so the
 * UI can decline to present capability the caller does not have, instead of
 * rendering an admin console and letting each call come back refused (#1104).
 *
 * The baseline groups are created by `modules/cloud/aws/auth` and the seeded
 * administrator is placed in `admin` there, so a freshly deployed instance
 * always has at least one principal who satisfies `ADMIN_GROUP`.
 */
import type { CognitoUserSession } from 'amazon-cognito-identity-js'

/**
 * The group that grants the infrastructure console and every admin-gated API
 * route. Mirrors `settings.admin_group` in `services/api/src/api/config.py`;
 * named once here so the portal cannot drift from the API it is fronting.
 */
export const ADMIN_GROUP = 'admin'

/**
 * The caller's Cognito groups, or `[]`.
 *
 * Fails **closed** in every degenerate case — a token with no `cognito:groups`
 * claim (the ordinary state of a user in no groups), a claim that is not an
 * array of strings, or a token that cannot be decoded at all. An empty list
 * satisfies no group requirement, so a malformed token refuses access rather
 * than being waved through: the alternative is a guard whose bypass is "send a
 * token this code cannot parse".
 */
export function sessionGroups(session: CognitoUserSession): string[] {
  let claim: unknown
  try {
    claim = session.getIdToken().decodePayload()['cognito:groups']
  } catch {
    return []
  }
  if (!Array.isArray(claim)) return []
  return claim.filter((group): group is string => typeof group === 'string')
}
