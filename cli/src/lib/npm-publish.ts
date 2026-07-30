/**
 * Reading an `npm publish` failure, for `.github/workflows/publish-cli.yml`.
 *
 * ## Why this is not just `run: npm publish`
 *
 * It was, and #342 is what that cost. Two commits shipped core 0.41.9; the
 * second publish hit npm's 403 "You cannot publish over the previously
 * published versions" and the job went red — correctly, as far as exit codes
 * go. But red on its own says nothing, and the run said nothing either: the
 * only record was npm's own line, in a workflow log nobody had a reason to
 * open. So `main` carried #337's changes, npm carried #338's as 0.41.9, and the
 * disagreement went unnoticed.
 *
 * The exit code was never the problem. The problem is that "npm is down" and
 * "this version was already released from a different tree" arrive looking
 * identical, and only one of them is fixed by pressing re-run. Getting that
 * wrong in either direction is expensive: re-running a transient failure is
 * free, while re-running an already-published one can never succeed and hides a
 * release-integrity failure behind an ordinary-looking red tick.
 *
 * So the classification lives here, where it can be tested against real npm
 * output, and the workflow's job is only to run `npm publish` and hand the log
 * over.
 *
 * ## What "already published" means here
 *
 * An npm version is immutable. Once `@biffo/cli@V` exists, whatever tree it was
 * built from is what V means to every consumer, forever — `core-v<V>` cannot
 * change that by pointing somewhere else (which is the same reason
 * `sync-core-tag` refuses to move a tag; see `core-tags.ts`). A 403 here is
 * therefore never a step to retry. It is a question for a person: does the
 * registry hold the tree this tag stands for, or not?
 *
 * npm answers that itself, if asked — it records `gitHead` on publish. Comparing
 * it with the commit being published turns "someone must decide which is right"
 * into a one-line verdict, so the failure report does that where it can.
 */

/** How a failed `npm publish` should be read. */
export type PublishFailureKind =
  /** The registry already has this exact version. Immutable; re-running cannot help. */
  | 'already-published'
  /** The token is missing, expired, or lacks publish rights on the package. */
  | 'auth'
  /** Anything else — an npm outage, a network blip, a broken tarball. Usually retryable. */
  | 'unknown'

/**
 * npm's wording for "that version exists", across the phrasings seen in the
 * wild. The registry returns 403 (not 409) for this, so the status code alone
 * cannot distinguish it from a permissions failure — the prose has to.
 */
const ALREADY_PUBLISHED = [
  /cannot publish over/i,
  /previously published version/i,
  /\bEPUBLISHCONFLICT\b/,
  /forbidden.*already exists/i,
]

/**
 * Authentication and authorisation. `E403` reaches here only when it did *not*
 * match above, so it is a genuine rights problem rather than a duplicate
 * version — the ordering below is load-bearing.
 */
const AUTH = [
  /\bENEEDAUTH\b/,
  /\bE401\b/,
  /401 Unauthorized/i,
  /\bneed auth\b/i,
  /do(?: not|n't) have permission/i,
  /you must be logged in/i,
  // 404 on a PUT is npm's UNAUTHORISED answer, not a missing package (#697).
  //
  // The registry declines to reveal whether a private package exists, so it
  // returns 404 rather than 403 to a caller without rights. It reads as "no such
  // package" and means "not allowed".
  //
  // This was already understood — the `auth` summary below has named the trap
  // since #664, where three consecutive re-dispatches were burned on it. What was
  // never written was the classifier entry, so a real E404 log fell through to
  // `unknown` and collected the advice "if it looks transient … re-dispatch this
  // workflow": precisely the loop #664 documented, recommended by the code that
  // documented it.
  //
  // Safe against the ordering above: the registry answers already-published with
  // 403, never 404, so this cannot shadow ALREADY_PUBLISHED. And this classifier
  // only ever reads `npm publish` output, where a 404 on PUT has no other meaning.
  /\bE404\b/,
  /404 Not Found - PUT/i,
]

/** Read npm's combined output. `already-published` wins over `auth`: both are 403s. */
export function classifyPublishFailure(log: string): PublishFailureKind {
  if (ALREADY_PUBLISHED.some((p) => p.test(log))) return 'already-published'
  if (AUTH.some((p) => p.test(log))) return 'auth'
  return 'unknown'
}

export interface PublishAttempt {
  /** Package name as published, e.g. `@biffo/cli`. */
  packageName: string
  /** Version being published — `core.version` at the tag. */
  version: string
  /** The `core-v*` tag being released. */
  tag: string
  /** Commit the tag resolves to. */
  commit: string
  /** npm's combined stdout and stderr. */
  log: string
  /**
   * `npm view <pkg>@<version> gitHead`, or null when npm reported nothing —
   * either the version genuinely is not there, or the field was never recorded.
   * Null is treated as "unknown", never as "matches".
   */
  registryGitHead: string | null
}

export interface PublishFailureReport {
  kind: PublishFailureKind
  /** `::error::` annotation bodies, in order. These surface outside the log. */
  annotations: string[]
  /** Markdown for `$GITHUB_STEP_SUMMARY`. */
  summary: string
}

/**
 * Last `n` non-empty lines of npm's output, for the cases where it is the
 * evidence. Bounded because a step summary has a size limit (1 MiB) and a
 * verbose npm failure can be long; the cause is always at the end.
 */
export function logTail(log: string, n = 20): string {
  const lines = log.split('\n').filter((l) => l.trim() !== '')
  return lines.slice(-n).join('\n')
}

const short = (sha: string): string => sha.slice(0, 8)

/**
 * Turn a failed attempt into something a person can act on without opening the
 * log: what happened, whether re-running can possibly help, and — for the
 * already-published case — the evidence needed to decide which of the tag and
 * the registry is right.
 */
export function describePublishFailure(attempt: PublishAttempt): PublishFailureReport {
  const kind = classifyPublishFailure(attempt.log)
  const { packageName, version, tag, commit, registryGitHead } = attempt
  const spec = `${packageName}@${version}`

  if (kind === 'already-published') {
    // Three verdicts, because the remedy differs completely and the run should
    // not make the reader work it out. npm records gitHead on publish, so the
    // registry can usually say for itself which tree it is holding.
    const verdict =
      registryGitHead === null
        ? {
            line:
              `The registry does not report a gitHead for ${spec}, so which tree it holds cannot be ` +
              `established from here. Treat the tag and the package as disagreeing until proven otherwise.`,
            summary:
              `npm reports no \`gitHead\` for \`${spec}\`, so this run cannot tell which tree was released. ` +
              `Inspect the artifact directly — \`npm view ${spec} dist.tarball\` — and compare it with \`${tag}\`.`,
          }
        : registryGitHead === commit
          ? {
              line:
                `The registry copy was built from ${short(commit)} — the same commit ${tag} points at. ${version} ` +
                `is already correctly released and this run is a duplicate; nothing needed publishing.`,
              summary:
                `The registry's \`gitHead\` matches \`${short(commit)}\`, the commit \`${tag}\` points at, so ` +
                `\`${spec}\` already holds exactly this tree. **The release is intact** — this run simply had ` +
                `nothing to do. It is red because it published nothing, not because anything is wrong.`,
            }
          : {
              line:
                `The registry copy was built from ${short(registryGitHead)}, but ${tag} points at ${short(commit)}. ` +
                `The tag and the published package describe different trees — this is the #342 failure, and it ` +
                `will not resolve itself.`,
              summary:
                `The registry's \`gitHead\` is \`${short(registryGitHead)}\`, but \`${tag}\` points at ` +
                `\`${short(commit)}\`. **The tag and the published package describe different trees** — exactly ` +
                `the state #342 was raised for. Someone has to decide which is right; \`${version}\` on npm ` +
                `cannot be changed, so in practice the tag or the version is what moves.`,
            }

    return {
      kind,
      annotations: [
        `${spec} is already on the npm registry — this run published nothing. npm versions are immutable, so ` +
          `re-running this workflow cannot succeed and will not fix it. This is a release-integrity failure, ` +
          `not a flake.`,
        verdict.line,
        `What to do: do NOT retry. Establish what ${version} actually contains (npm view ${spec} gitHead ` +
          `dist.tarball), then fix forward by bumping core.version on main so the tree at ${short(commit)} gets a ` +
          `version, tag and release of its own. See issue #342.`,
      ],
      summary:
        `### ❌ \`${spec}\` is already published — nothing was released\n\n` +
        `\`npm publish\` was refused because version \`${version}\` already exists on the registry. npm ` +
        `versions are immutable: **re-running this workflow cannot succeed.**\n\n` +
        `| | |\n| --- | --- |\n` +
        `| Tag | \`${tag}\` |\n` +
        `| Tag commit | \`${short(commit)}\` |\n` +
        `| Registry \`gitHead\` | ${registryGitHead === null ? '_not reported_' : `\`${short(registryGitHead)}\``} |\n\n` +
        `${verdict.summary}\n\n` +
        `**How to resolve**\n\n` +
        `1. \`npm view ${spec} gitHead dist.tarball\` — establish what \`${version}\` actually shipped.\n` +
        `2. Fix forward: bump \`core.version\` on \`main\`, so the tree being released here gets a version, a ` +
        `tag and a publish of its own. Never re-point \`${tag}\` at it — that is what made the tag and the ` +
        `registry disagree in #342.\n` +
        `3. If two commits on \`main\` are carrying \`${version}\`, \`core-tag.yml\` is already failing for the ` +
        `same reason; resolving that resolves this.\n`,
    }
  }

  if (kind === 'auth') {
    return {
      kind,
      annotations: [
        `npm rejected the credentials for ${spec}: trusted publishing (OIDC) did not authenticate against ` +
          `${packageName}. Nothing was published.`,
        `What to do: this is almost never fixed by a re-run. Check npmjs.com -> ${packageName} -> Settings -> ` +
          `Trusted Publisher still names this repository AND this workflow filename, and that the publish job ` +
          `requests 'id-token: write' and runs npm >= 11.5.1 (older npm ignores OIDC entirely and fails here ` +
          `looking like a missing package).`,
      ],
      summary:
        `### ❌ npm rejected the credentials\n\n` +
        `\`${spec}\` was not published: trusted publishing (OIDC) did not authenticate against ` +
        `\`${packageName}\`.\n\n` +
        `**A re-run will not help unless something changed.** npm answers **404 on the PUT** rather than 403 ` +
        `when a publish is unauthorised — deliberately, so it does not reveal whether a private package ` +
        `exists — so this reads like "no such package" when it is really "not allowed to publish". Check, in ` +
        `order:\n\n` +
        `1. npmjs.com → \`${packageName}\` → Settings → **Trusted Publisher** still names this repository and ` +
        `this **workflow filename**. Renaming the workflow file breaks publishing until the registration is ` +
        `updated to match.\n` +
        `2. The publish job requests \`id-token: write\`.\n` +
        `3. The job runs **npm >= 11.5.1**. Older npm ignores OIDC and fails exactly like this (#664).\n\n` +
        `The version is still unpublished, so a re-run is safe once the cause is fixed.\n\n` +
        '```\n' +
        logTail(attempt.log) +
        '\n```\n',
    }
  }

  return {
    kind,
    annotations: [
      `npm publish failed for ${spec} and the cause is not one this workflow recognises. The version was NOT ` +
        `published, so a re-run is safe.`,
      `What to do: read the tail of npm's output in the job summary. If it looks transient (registry 5xx, ` +
        `network, provenance/OIDC hiccup), re-dispatch this workflow against ${tag}.`,
    ],
    summary:
      `### ❌ \`npm publish\` failed — cause not recognised\n\n` +
      `\`${spec}\` was **not** published, so re-dispatching this workflow against \`${tag}\` is safe and is ` +
      `the first thing to try. If it fails the same way twice, the cause is not transient.\n\n` +
      '```\n' +
      logTail(attempt.log) +
      '\n```\n',
  }
}
