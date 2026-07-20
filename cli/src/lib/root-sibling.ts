/**
 * The root application sibling (issue #306, ADR-0007 amendment 2026-07-20).
 *
 * ADR-0007 originally defined every sibling as path-routed at
 * `baseurl.com/<name>`, with its Next.js `basePath` set to that same segment.
 * The root application is the same mechanism with an **empty** path prefix: it
 * serves `/`, takes the CDN's `default_cache_behavior` rather than a pair of
 * `ordered_cache_behavior` patterns, and therefore owns `/_next/*` (which
 * phase 1 vacated by giving the portal `assetPrefix: '/admin'`).
 *
 * ── name vs path prefix ─────────────────────────────────────────────────────
 *
 * These are two different things and conflating them breaks teardown.
 *
 *   - **path prefix** — the URL segment. Empty (`''`) for the root sibling.
 *   - **registry name** — the key of an entry in
 *     `infra/environments/<env>/siblings.auto.tfvars.json`
 *     (`sibling_origins[].name`). It names the CloudFront origin
 *     (`sibling-<name>`) and is what `collectSiblings()` in
 *     lib/sibling-teardown.ts keys siblings by. It must be non-empty and
 *     unique, or a registered sibling becomes undiscoverable — and an
 *     undiscoverable sibling is one `biffo teardown` silently leaves behind,
 *     still billing.
 *
 * For every ordinary sibling the two are the same string. For the root sibling
 * the path prefix is `''` and the registry name is the reserved word `app`.
 * That is the whole trick: the registry stays keyed on a real name while the
 * routing prefix is empty.
 */

/**
 * The reserved registry name of the root application sibling. Reserved in the
 * same sense as `admin` and `login` (the portal's own CloudFront prefixes): no
 * *other* sibling may claim it.
 */
export const ROOT_SIBLING_NAME = 'app'

/**
 * Registry names no ordinary sibling may take. `admin`/`login` belong to the
 * portal's own ordered cache behaviours; `app` belongs to the root sibling.
 */
export const RESERVED_SIBLING_NAMES = ['admin', 'login', ROOT_SIBLING_NAME] as const

/** True when this sibling serves `/` rather than `/<prefix>`. */
export function isRootPathPrefix(pathPrefix: string): boolean {
  return pathPrefix === ''
}

/**
 * The `sibling_origins[].name` to register a sibling under, given its path
 * prefix. Never returns an empty string — see the note above.
 */
export function registryNameFor(pathPrefix: string): string {
  return isRootPathPrefix(pathPrefix) ? ROOT_SIBLING_NAME : pathPrefix
}

/** How a path prefix is rendered in human output: `/` for the root. */
export function displayPath(pathPrefix: string): string {
  return isRootPathPrefix(pathPrefix) ? '/' : `/${pathPrefix}`
}

/**
 * The value of `NEXT_PUBLIC_BASE_PATH` / Next.js `basePath` for a prefix.
 *
 * Empty string for the root — NOT `/`. Next.js rejects a `basePath` of `/`
 * ("specified basePath has to be a path starting with /, but not ending with
 * one"), so the naive `` `/${prefix}` `` would produce a sibling that cannot
 * build at all.
 */
export function basePathFor(pathPrefix: string): string {
  return isRootPathPrefix(pathPrefix) ? '' : `/${pathPrefix}`
}

/**
 * The project (and GitHub repo) name of the root application sibling created
 * by `biffo init` for a core project.
 *
 * `<core>-app`, derived rather than asked for, because three separate things
 * must agree on it and only a derivation keeps them agreeing:
 *
 *   1. `resolveSiblingRepos()` resolves a sibling's repo as
 *      `<coreOrg>/<projectName>` — so repo name and project name cannot
 *      diverge without making teardown unable to find the repo.
 *   2. the sibling's S3 site bucket is `<projectName>-<env>-site-<account>`,
 *      which is how teardown recovers the project name back out of the
 *      registry. Prefixing with the core project keeps it distinctive within
 *      the account and readable in the org's repo list.
 *   3. `biffo init` is non-interactive-capable (#274), so it cannot prompt for
 *      a name it does not already have.
 */
export function rootSiblingProjectName(coreProjectName: string): string {
  return `${coreProjectName}-app`
}

/**
 * AWS's S3 virtual-hosted-style regional domain — us-east-1 uses the legacy
 * global endpoint form, every other region includes the region in the host.
 */
export function bucketRegionalDomain(bucketName: string, region: string): string {
  return region === 'us-east-1'
    ? `${bucketName}.s3.amazonaws.com`
    : `${bucketName}.s3.${region}.amazonaws.com`
}

/** Matches modules/cloud/aws/storage/main.tf's local.site_bucket naming. */
export function siteBucketName(
  projectName: string,
  environment: string,
  accountId: string,
): string {
  return `${projectName}-${environment}-site-${accountId}`
}

/**
 * One `sibling_origins` entry, as written into
 * `infra/environments/<env>/siblings.auto.tfvars.json`.
 */
export interface SiblingOrigin {
  name: string
  bucket_regional_domain: string
  description?: string
  routes?: Array<{ path: string; label: string }>
}

/**
 * Add (or replace) one sibling in a registry file's entry list, keyed by
 * registry name. Shared by `biffo sibling create`'s registration PR and
 * `biffo init`'s direct registration of the root sibling, so both produce
 * byte-identical files.
 */
export function upsertSiblingOrigin(
  existing: SiblingOrigin[],
  entry: SiblingOrigin,
): SiblingOrigin[] {
  return [...existing.filter((s) => s.name !== entry.name), entry]
}

/** Serialize a registry file exactly as both writers must produce it. */
export function serializeRegistry(origins: SiblingOrigin[]): string {
  return JSON.stringify({ sibling_origins: origins }, null, 2) + '\n'
}
