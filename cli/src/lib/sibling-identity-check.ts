/**
 * Stale-Cognito-identity detection for a core project and its siblings (#400).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A Biffo core owns the Cognito user pool every one of its siblings trusts to
 * mint and verify tokens. If the core ever *replaces* that pool (a destroy +
 * recreate, an import gone wrong, a fresh environment), the pool id changes —
 * and two independent copies of the old id can silently rot:
 *
 *   1. The **published identity document** the core serves at
 *      `${portalUrl}/.well-known/biffo-identity.json` (#403). Sibling FRONTENDS
 *      read this at runtime, so a deploy that recreated the pool but failed to
 *      refresh the document leaves every sibling front-end pointed at a pool
 *      that no longer exists. The document is meant to be the live truth; when
 *      it drifts from the live pool it is worse than useless, because it looks
 *      authoritative.
 *
 *   2. Each sibling's **backend** bakes the core pool id at deploy time via the
 *      `CORE_COGNITO_USER_POOL_ID` GitHub environment variable, used as
 *      `TF_VAR_core_cognito_user_pool_id` to build the JWKS URL its API verifies
 *      tokens against (#496). Unlike the front-end, this is NOT resolved at
 *      runtime — it is compiled into the sibling's infra. So a core that
 *      replaced its pool will 401 otherwise-valid tokens from any sibling whose
 *      variable still names the old pool, until that sibling redeploys.
 *
 * Both failures are silent: nothing errors at deploy time, the core's own run is
 * green, and the break only surfaces later as auth failures no single repo's CI
 * would catch. This module turns that into something a scheduled/CI run can fail
 * on loudly — the "red run" #400 asked for — by comparing BOTH copies, per
 * environment, against the *live* pool id read from the core's Terraform output
 * `cognito_user_pool_id`.
 *
 * ── Purity ──────────────────────────────────────────────────────────────────
 *
 * This file does no I/O. The command layer
 * (`commands/sibling-check-identity.ts`) fetches the live pool id, the published
 * document, and each sibling's variable, and hands the assembled facts here.
 * Keeping the comparison pure makes every drift case exhaustively unit-testable
 * without AWS, GitHub, or the network.
 */

export type IdentityFindingKind =
  /** The core's /.well-known/biffo-identity.json could not be fetched/parsed. */
  | 'published-doc-unreachable'
  /** The document was fetched but its userPoolId != the live pool (#403 drift). */
  | 'published-doc-stale'
  /** A registered sibling has no CORE_COGNITO_USER_POOL_ID for this env (#496). */
  | 'sibling-var-missing'
  /** A sibling has the variable, but it != the live pool — its backend will 401 (#496). */
  | 'sibling-backend-stale'

export interface IdentityFinding {
  environment: string
  /** `'published-document'` or the sibling's projectName. */
  subject: string
  kind: IdentityFindingKind
  /** The live pool id — what everything should agree with. */
  expected: string
  /** What was actually found (document's userPoolId / sibling var / null). */
  actual: string | null
}

export interface IdentityCheckEnvInput {
  environment: string
  /** The live Cognito pool id from the core's `cognito_user_pool_id` output. */
  livePoolId: string
  /** Parsed published document, or `null` when it was unreachable/unparseable. */
  publishedDoc: { userPoolId?: string | null } | null
  siblings: { projectName: string; coreCognitoUserPoolId: string | null }[]
}

/**
 * Compare each environment's published document and each sibling's baked-in pool
 * id against the live pool id. `ok` is true only when nothing drifted.
 *
 * The rules are intentionally exhaustive and order-stable (document first, then
 * siblings in the order given) so callers can render a deterministic report.
 */
export function checkSiblingIdentity(envs: IdentityCheckEnvInput[]): {
  ok: boolean
  findings: IdentityFinding[]
} {
  const findings: IdentityFinding[] = []

  for (const env of envs) {
    // 1. The published document (#403). Unreachable is distinct from stale: an
    //    unreachable document means siblings' front-ends have nothing to resolve
    //    at all, while a stale one actively points them at a dead pool.
    if (env.publishedDoc === null) {
      findings.push({
        environment: env.environment,
        subject: 'published-document',
        kind: 'published-doc-unreachable',
        expected: env.livePoolId,
        actual: null,
      })
    } else {
      const docPool = env.publishedDoc.userPoolId ?? null
      if (docPool !== env.livePoolId) {
        findings.push({
          environment: env.environment,
          subject: 'published-document',
          kind: 'published-doc-stale',
          expected: env.livePoolId,
          actual: docPool,
        })
      }
    }

    // 2. Each sibling's baked-in backend pool id (#496). A missing variable and a
    //    wrong one are reported separately: missing means the sibling was never
    //    wired for this env, wrong means it was wired to a pool the core replaced.
    for (const sibling of env.siblings) {
      if (sibling.coreCognitoUserPoolId === null) {
        findings.push({
          environment: env.environment,
          subject: sibling.projectName,
          kind: 'sibling-var-missing',
          expected: env.livePoolId,
          actual: null,
        })
      } else if (sibling.coreCognitoUserPoolId !== env.livePoolId) {
        findings.push({
          environment: env.environment,
          subject: sibling.projectName,
          kind: 'sibling-backend-stale',
          expected: env.livePoolId,
          actual: sibling.coreCognitoUserPoolId,
        })
      }
    }
  }

  return { ok: findings.length === 0, findings }
}
