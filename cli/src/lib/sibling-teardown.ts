/**
 * Sibling discovery for `biffo teardown` (issue #306).
 *
 * `biffo sibling create` (ADR-0007) leaves **no durable local record** — it
 * calls `deleteSiblingSession()` on success, and there is no companion
 * "project config" store the way `biffo init` has one. So teardown cannot ask
 * `~/.biffo` which siblings exist; by the time teardown runs, that directory
 * has forgotten them.
 *
 * What a sibling actually is, and where each part lives:
 *
 *   1. its own GitHub repo                        — `<org>/<repo>`
 *   2. its own AWS OIDC role                      — `biffo-github-actions-<project>`
 *   3. its own Terraform state bucket             — `<project>-terraform-state-<account>`
 *   4. its own per-env AWS infra                  — S3 site bucket, Lambda, API GW
 *   5. an entry in the CORE repo's
 *      `infra/environments/<env>/siblings.auto.tfvars.json`, which becomes one
 *      CloudFront origin plus TWO ordered cache behaviours ("<name>" and
 *      "<name>/*") on the CORE's distribution.
 *
 * Note (3)/(4): the sibling's static assets do **not** live under the core
 * portal's bucket. They live under `<PATH_PREFIX>/` inside the sibling's *own*
 * S3 bucket, which the core's CDN registers as a separate origin. Deleting the
 * core's portal bucket therefore does not reclaim a sibling's storage — only
 * the sibling's own terraform destroy does.
 *
 * ── Source of truth ─────────────────────────────────────────────────────────
 *
 * `infra/environments/<env>/siblings.auto.tfvars.json`, read from the **core
 * repo on GitHub** (not from any local checkout), is the registry. It is the
 * right source because:
 *
 *   - it is what the CDN actually reads, so anything routed is in it;
 *   - it survives on any machine, unlike the deleted sibling session;
 *   - `bucket_regional_domain` deterministically encodes the sibling's project
 *     name, environment and AWS account, which is exactly what we need to name
 *     its IAM role and state bucket — no guessing.
 *
 * Two cases the merged registry alone would miss, both handled here:
 *
 *   - **created but never registered** — the registration PR is still open, so
 *     nothing is merged yet. Recovered by also reading the registry file from
 *     the head ref of any open `biffo/register-sibling-*` PR.
 *   - **registered but the repo was manually deleted** — the entry is merged
 *     but `<org>/<project>` 404s. Recorded as `repoState: 'gone'` so teardown
 *     still reclaims the AWS-side resources and does not try to delete a repo
 *     that isn't there.
 *
 * ── Fail-closed repo resolution ─────────────────────────────────────────────
 *
 * The registry records routing, not provenance: it has no GitHub repo field.
 * So the repo is resolved by *verification*, never by assumption. We look for
 * `biffo.sibling.json` (written by `writeSiblingTemplate`) at the candidate
 * repo's root and require it to name this exact core project and path prefix.
 * A repo that exists but does not carry that marker is treated as an
 * unrelated repo that merely shares a name, and aborts the whole teardown —
 * deleting the wrong repo is irreversible and far worse than stopping.
 */

import { ROOT_SIBLING_NAME } from './root-sibling.js'

/** One entry as written into `siblings.auto.tfvars.json` by the registration PR. */
export interface SiblingOriginEntry {
  name: string
  bucket_regional_domain: string
  description?: string
  routes?: Array<{ path: string; label: string }>
}

/** A sibling as discovered from the core repo, before its repo is resolved. */
export interface DiscoveredSibling {
  /** The CDN path segment — `baseurl.com/<pathPrefix>`. Unique per core project. */
  pathPrefix: string
  /** The sibling's own biffo project name, recovered from its site bucket name. */
  projectName: string
  /** Environments whose registry file listed this sibling. */
  environments: string[]
  /** AWS account the sibling's own resources live in. */
  accountId: string
  /** True once the registration PR has merged (present in the base branch). */
  registered: boolean
  /** Set when only an open registration PR mentions this sibling. */
  pendingRegistrationPr?: number
}

/** A sibling whose GitHub repo has been positively identified (or proven gone). */
export interface ResolvedSibling extends DiscoveredSibling {
  org: string
  repo: string
  repoState: 'present' | 'gone'
}

export class SiblingResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SiblingResolutionError'
  }
}

/** The environments a core project's registry can be split across. */
export const REGISTRY_ENVIRONMENTS = ['dev', 'staging', 'prod'] as const

export function registryPath(environment: string): string {
  return `infra/environments/${environment}/siblings.auto.tfvars.json`
}

/** The branch prefix `biffo sibling create` uses for its registration PR. */
export const REGISTRATION_BRANCH_PREFIX = 'biffo/register-sibling-'

/**
 * Recover a sibling's project name, environment and account from the S3
 * regional domain the registration PR recorded.
 *
 * Mirrors `siteBucketName()` + `bucketRegionalDomain()` in sibling-create.ts:
 *   <project>-<env>-site-<account>.s3.amazonaws.com            (us-east-1)
 *   <project>-<env>-site-<account>.s3.<region>.amazonaws.com   (elsewhere)
 *
 * Returns null when the domain does not match — the caller treats that as
 * unresolvable and aborts rather than inventing a project name.
 */
export function parseSiblingBucketDomain(
  domain: string,
): { projectName: string; environment: string; accountId: string } | null {
  const host = /^(?<bucket>[a-z0-9][a-z0-9.-]*)\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/.exec(domain)
  const bucket = host?.groups?.['bucket']
  if (!bucket) return null

  // Project names may contain dashes, so anchor on the fixed `-<env>-site-<12 digits>` tail.
  const parts = /^(?<project>.+)-(?<env>dev|staging|prod)-site-(?<account>\d{12})$/.exec(bucket)
  const project = parts?.groups?.['project']
  const env = parts?.groups?.['env']
  const account = parts?.groups?.['account']
  if (!project || !env || !account) return null

  return { projectName: project, environment: env, accountId: account }
}

/** Parse a registry file's contents, tolerating an absent or empty file. */
export function parseRegistry(contents: string | undefined): SiblingOriginEntry[] {
  if (contents === undefined || contents.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    throw new SiblingResolutionError(
      'A siblings.auto.tfvars.json in the core repo is not valid JSON. Refusing to tear down ' +
        'while the sibling registry cannot be read — fix or remove the file and re-run.',
    )
  }
  const origins = (parsed as { sibling_origins?: unknown }).sibling_origins
  if (origins === undefined) return []
  if (!Array.isArray(origins)) {
    throw new SiblingResolutionError(
      'sibling_origins in the core repo is not a list. Refusing to tear down while the sibling ' +
        'registry cannot be read.',
    )
  }
  return origins as SiblingOriginEntry[]
}

/**
 * Fold registry entries (from one or more environments, merged or pending)
 * into one sibling per path prefix.
 *
 * Throws rather than skipping when an entry cannot be decoded: an entry we
 * cannot name is a sibling we would silently leak, which is precisely the
 * failure #306 is about.
 */
export function collectSiblings(
  sources: Array<{
    environment: string
    entries: SiblingOriginEntry[]
    pendingRegistrationPr?: number
  }>,
): DiscoveredSibling[] {
  const byPrefix = new Map<string, DiscoveredSibling>()

  for (const source of sources) {
    for (const entry of source.entries) {
      if (!entry?.name || !entry.bucket_regional_domain) {
        throw new SiblingResolutionError(
          `A sibling entry in ${registryPath(source.environment)} is missing name or ` +
            'bucket_regional_domain. Refusing to tear down while a registered sibling cannot be ' +
            'identified — it would be left behind, still billing.',
        )
      }

      const parsed = parseSiblingBucketDomain(entry.bucket_regional_domain)
      if (!parsed) {
        throw new SiblingResolutionError(
          `Could not work out which project owns the sibling "${entry.name}" from its bucket ` +
            `"${entry.bucket_regional_domain}" (in ${registryPath(source.environment)}).\n` +
            '  Refusing to guess — tear that sibling down by hand, remove its entry, then re-run.',
        )
      }

      const existing = byPrefix.get(entry.name)
      if (existing) {
        if (existing.projectName !== parsed.projectName) {
          throw new SiblingResolutionError(
            `The sibling "${entry.name}" maps to two different projects across environments ` +
              `("${existing.projectName}" and "${parsed.projectName}"). Refusing to guess which ` +
              'repo to delete — resolve the registry by hand and re-run.',
          )
        }
        if (!existing.environments.includes(parsed.environment)) {
          existing.environments.push(parsed.environment)
        }
        // A merged entry always wins over a pending one.
        if (source.pendingRegistrationPr === undefined) {
          existing.registered = true
          delete existing.pendingRegistrationPr
        }
        continue
      }

      byPrefix.set(entry.name, {
        pathPrefix: entry.name,
        projectName: parsed.projectName,
        environments: [parsed.environment],
        accountId: parsed.accountId,
        registered: source.pendingRegistrationPr === undefined,
        ...(source.pendingRegistrationPr !== undefined
          ? { pendingRegistrationPr: source.pendingRegistrationPr }
          : {}),
      })
    }
  }

  return [...byPrefix.values()].sort((a, b) => a.pathPrefix.localeCompare(b.pathPrefix))
}

/**
 * The marker file `writeSiblingTemplate` bakes into every sibling repo root.
 * Its presence — naming *this* core project and *this* path prefix — is the
 * only evidence we accept that a repo is the sibling we mean to delete.
 */
export interface SiblingMarker {
  name?: string
  core_project?: string
  path_prefix?: string
}

export const SIBLING_MARKER_FILE = 'biffo.sibling.json'

/**
 * Decide whether `biffo.sibling.json` proves a repo is the sibling we mean.
 *
 * Deliberately strict: the core project must match exactly, and the marker must
 * agree with the registry on either the path prefix or the project name. A repo
 * that merely happens to be named like the sibling fails this and aborts the run.
 */
export function markerMatches(
  marker: SiblingMarker | null,
  coreProjectName: string,
  sibling: DiscoveredSibling,
): boolean {
  if (!marker) return false
  if (marker.core_project !== coreProjectName) return false
  if (marker.path_prefix === sibling.pathPrefix) return true
  // The ROOT application sibling (issue #306): registered under the reserved
  // name "app" but carrying an EMPTY path_prefix in its marker, because those
  // are two different things — the registry name is the routing key, the
  // prefix is the URL segment, and only the prefix is empty. Recognised
  // explicitly rather than left to fall through to the project-name clause
  // below, so that a root sibling whose repo was renamed still fails closed
  // for the right reason instead of matching by accident.
  if (marker.path_prefix === '' && sibling.pathPrefix === ROOT_SIBLING_NAME) return true
  return marker.name === sibling.projectName
}

/** Minimal GitHub surface `resolveSiblingRepos` needs — keeps it unit-testable. */
export interface SiblingRepoLookup {
  repoExists(org: string, repo: string): Promise<boolean>
  getFileContent(org: string, repo: string, path: string, ref?: string): Promise<string | undefined>
}

/**
 * Turn discovered siblings into repos we are *certain* about.
 *
 * `<coreOrg>/<projectName>` is only ever a **candidate**. It is accepted solely
 * when the repo carries a matching `biffo.sibling.json`. Anything else — repo
 * present without the marker, or with a marker naming a different core —
 * throws, and teardown stops before deleting anything at all.
 */
export async function resolveSiblingRepos(
  github: SiblingRepoLookup,
  coreOrg: string,
  coreProjectName: string,
  siblings: DiscoveredSibling[],
): Promise<ResolvedSibling[]> {
  const resolved: ResolvedSibling[] = []

  for (const sibling of siblings) {
    const repo = sibling.projectName

    if (!(await github.repoExists(coreOrg, repo))) {
      // Registered, then manually deleted. Not an error: there is no repo to
      // delete, and its AWS-side resources are still ours to reclaim.
      resolved.push({ ...sibling, org: coreOrg, repo, repoState: 'gone' })
      continue
    }

    const raw = await github.getFileContent(coreOrg, repo, SIBLING_MARKER_FILE)
    let marker: SiblingMarker | null = null
    if (raw !== undefined) {
      try {
        marker = JSON.parse(raw) as SiblingMarker
      } catch {
        marker = null
      }
    }

    if (!markerMatches(marker, coreProjectName, sibling)) {
      throw new SiblingResolutionError(
        `Refusing to tear down: ${coreOrg}/${repo} is registered as the sibling ` +
          `"${sibling.pathPrefix}" of "${coreProjectName}", but that repo does not carry a ` +
          `matching ${SIBLING_MARKER_FILE}.\n` +
          '  It may be an unrelated repo that happens to share the name. Deleting a repo cannot ' +
          'be undone, so nothing has been deleted.\n' +
          `  Delete ${coreOrg}/${repo} by hand if it really is the sibling, remove its entry from ` +
          "the core repo's siblings.auto.tfvars.json, then re-run biffo teardown.",
      )
    }

    resolved.push({ ...sibling, org: coreOrg, repo, repoState: 'present' })
  }

  return resolved
}
