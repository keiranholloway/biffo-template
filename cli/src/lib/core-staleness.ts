import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { carriedPrNumbers } from '../commands/core-upgrade.js'
import {
  CORE_TAG_PREFIX,
  INSTANCE_CORE_FILE,
  compareCoreVersions,
  parseCoreVersion,
  readInstanceCoreVersion,
} from './core-version.js'

/**
 * The (instance, biffo-template) staleness decision: is this instance's pinned
 * core older than the newest `core-v*` tag?
 *
 * The same rule `plugin-staleness.ts` applies to (instance, plugin) pairs, run
 * by the same workflow (`plugin-staleness-report.yml`), which files one
 * fleet-buildable issue per behind instance. Pure over its inputs: the caller
 * supplies the tag list and a way to read squash subjects between two tags.
 */

export interface CoreStalenessFinding {
  kind: 'core'
  /** Always `biffo-template`; lets the plugin-shaped filer read `name`. */
  name: 'biffo-template'
  status: 'behind' | 'cannot-tell'
  detail: string
  /** The instance's recorded version, when it could be read. */
  pin?: string
  /** Newest `core-v*` tag, e.g. `core-v0.384.0`. */
  newestTag?: string
  /** Releases (tags) strictly newer than the pin, up to and including the newest. */
  behindBy?: number
  /** Template PR numbers carried between the pin and the newest tag. */
  carriedPrs?: number[]
}

export interface CoreStalenessDeps {
  /** Every `core-v*` tag in the template checkout (other names are ignored). */
  tags: string[]
  /** Commit subjects in `core-v<from>..core-v<to>`; may throw (treated as none). */
  subjectsBetween?: (fromTag: string, toTag: string) => string[]
}

/**
 * Zero findings for a repo with no `biffo.core.json` (not an instance) or one
 * that is current; exactly one otherwise. A present-but-unreadable record is
 * `cannot-tell`, never "current".
 */
export function checkCoreStaleness(
  instanceDir: string,
  deps: CoreStalenessDeps,
): CoreStalenessFinding[] {
  if (!existsSync(join(instanceDir, INSTANCE_CORE_FILE))) return []

  const cannotTell = (detail: string): CoreStalenessFinding[] => [
    { kind: 'core', name: 'biffo-template', status: 'cannot-tell', detail },
  ]

  let pin: string | null
  try {
    pin = readInstanceCoreVersion(instanceDir)
    if (pin === null) return cannotTell(`${INSTANCE_CORE_FILE} records no version`)
    parseCoreVersion(pin)
  } catch (err) {
    return cannotTell(`${INSTANCE_CORE_FILE} is unreadable: ${(err as Error).message}`)
  }

  const versions = deps.tags
    .map((t) => t.trim())
    .filter((t) => t.startsWith(CORE_TAG_PREFIX))
    .map((t) => t.slice(CORE_TAG_PREFIX.length))
    .filter((v) => {
      try {
        parseCoreVersion(v)
        return true
      } catch {
        return false
      }
    })
    .sort(compareCoreVersions)
  const newest = versions.at(-1)
  if (!newest) return cannotTell('no core-v* tag found in the template checkout')

  if (compareCoreVersions(pin, newest) >= 0) return []

  const behindBy = versions.filter((v) => compareCoreVersions(v, pin as string) > 0).length
  let carriedPrs: number[] = []
  try {
    carriedPrs = carriedPrNumbers(
      deps.subjectsBetween?.(`${CORE_TAG_PREFIX}${pin}`, `${CORE_TAG_PREFIX}${newest}`) ?? [],
    )
  } catch {
    /* provenance only: a missing pin tag must not hide the staleness */
  }
  const newestTag = `${CORE_TAG_PREFIX}${newest}`
  return [
    {
      kind: 'core',
      name: 'biffo-template',
      status: 'behind',
      detail: `core is pinned at ${pin}, ${behindBy} release(s) behind ${newestTag}`,
      pin,
      newestTag,
      behindBy,
      carriedPrs,
    },
  ]
}

/** The one stable title per instance: no version, so it spans many releases. */
export function coreStalenessTitle(instance: string): string {
  return `core staleness: ${instance} is behind biffo-template`
}

/** Body of the issue a builder works from. Only the fields a builder needs. */
export function coreStalenessBody(finding: CoreStalenessFinding, runUrl: string): string {
  const prs = finding.carriedPrs ?? []
  return [
    `\`${finding.detail}\``,
    '',
    `Current pin: \`${finding.pin ?? 'unknown'}\``,
    `Newest tag: \`${finding.newestTag ?? 'unknown'}\``,
    `Template PRs carried by this upgrade: ${prs.length}`,
    '',
    '**Remedy** (run in your own checkout of this repo):',
    '',
    '```',
    'git clone --filter=blob:none https://github.com/keiranholloway/biffo-template "$TMPDIR/biffo-template"',
    'npx @biffo/cli core upgrade --template-repo "$TMPDIR/biffo-template" --apply --no-push',
    '```',
    '',
    "This command makes the upgrade's own mechanical commit. Do not hand-merge template files. " +
      'If the dry-run plan reports conflicts, stop and report the conflicted paths.',
    '',
    'Detected by `plugin-staleness-report.yml` in keiranholloway/biffo-template; filed here because this is where the upgrade has to happen.',
    `Run: ${runUrl}`,
    '',
    'This issue is not auto-closed on the next clean run -- confirm the upgrade PR actually merged before closing it.',
  ].join('\n')
}

export interface CoreIssueGh {
  /** Titles of open issues in `repo`. Throws if the listing cannot be read. */
  listOpenTitles(repo: string): string[]
  create(repo: string, title: string, body: string): string
}

/**
 * File the instance's core-staleness issue unless one is already open.
 * An open one is left alone -- no comment, no new issue: the builder always
 * upgrades to the newest tag when it runs.
 */
export function fileCoreStalenessIssue(
  instance: string,
  instanceRepo: string,
  finding: CoreStalenessFinding,
  runUrl: string,
  gh: CoreIssueGh,
): { action: 'opened' | 'exists'; url?: string } {
  const title = coreStalenessTitle(instance)
  if (gh.listOpenTitles(instanceRepo).includes(title)) return { action: 'exists' }
  return {
    action: 'opened',
    url: gh.create(instanceRepo, title, coreStalenessBody(finding, runUrl)),
  }
}
