import type { GitHubAdapter } from '../adapters/source-control/github/index.js'
import type { ProvisioningConfig } from '../config/schema.js'
import { log } from './logger.js'

/**
 * Resolve the immutable numeric GitHub owner/repo IDs the OIDC trust policy
 * pins (see `oidcSubjectPatterns` in the AWS adapter, and issue #271).
 *
 * Best-effort by design: on any GitHub API failure this returns `undefined`
 * rather than aborting provisioning, and the AWS adapter then writes the legacy
 * subject pattern alone and warns. That is the fail-closed direction — a
 * transient API error must never cause a *wider* trust policy than intended,
 * and re-running `biffo init` repairs a role written without IDs.
 */
export async function resolveRepoIds(
  github: GitHubAdapter,
  config: ProvisioningConfig,
): Promise<{ ownerId: number; repoId: number } | undefined> {
  const sc = config.source_control as {
    provider: string
    config: { org: string; repo: string }
  }
  if (sc.provider !== 'github') return undefined
  try {
    return await github.getRepoIds(sc.config.org, sc.config.repo)
  } catch (err: unknown) {
    log.warn(`Could not resolve GitHub repository IDs: ${(err as Error).message}`)
    return undefined
  }
}
