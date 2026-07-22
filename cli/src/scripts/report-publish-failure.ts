/**
 * Explain a failed `npm publish` in the run that failed, then fail the job.
 *
 * Run from `.github/workflows/publish-cli.yml`, only on the failure path:
 *
 *     pnpm --filter @biffo/cli report:publish-failure
 *
 * It reads npm's captured output and the registry's own record of the version,
 * and emits `::error::` annotations (which appear on the run summary page, not
 * only in the log) plus a `$GITHUB_STEP_SUMMARY` section. The judgement itself
 * — whether this is "already released from another tree" or an ordinary blip —
 * lives in `../lib/npm-publish.ts`, where it is tested against real npm output;
 * this file is only plumbing.
 *
 * Always exits non-zero: it runs only when publishing failed, and #342 is what
 * happened when that failure was technically red but effectively invisible.
 *
 * Inputs, all via the environment so the workflow needs no argument quoting:
 *
 *   PUBLISH_PACKAGE      package name, e.g. `@biffo/cli`
 *   PUBLISH_VERSION      version that was being published
 *   PUBLISH_TAG          `core-v<version>` tag being released
 *   PUBLISH_COMMIT       commit the tag resolves to
 *   PUBLISH_LOG          path to npm's captured stdout+stderr
 *   PUBLISH_REGISTRY_GIT_HEAD  `npm view <spec> gitHead`, empty when unknown
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { describePublishFailure } from '../lib/npm-publish.js'

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`::error::${name} is not set — cannot report the publish failure.`)
    process.exit(2)
  }
  return value
}

function main(): void {
  const logPath = process.env['PUBLISH_LOG']
  // A missing or unreadable log must not swallow the failure: report on what
  // there is. An empty log classifies as `unknown`, which tells the reader to
  // retry — the safe advice when nothing was published.
  let log = ''
  if (logPath) {
    try {
      log = readFileSync(logPath, 'utf8')
    } catch {
      log = `(npm output could not be read from ${logPath})`
    }
  }

  const gitHead = (process.env['PUBLISH_REGISTRY_GIT_HEAD'] ?? '').trim()

  const report = describePublishFailure({
    packageName: required('PUBLISH_PACKAGE'),
    version: required('PUBLISH_VERSION'),
    tag: required('PUBLISH_TAG'),
    commit: required('PUBLISH_COMMIT'),
    log,
    registryGitHead: gitHead === '' ? null : gitHead,
  })

  for (const annotation of report.annotations) {
    // Single-line: GitHub truncates an annotation at the first newline.
    console.log(`::error::${annotation.replace(/\s*\n\s*/g, ' ')}`)
  }

  const summaryPath = process.env['GITHUB_STEP_SUMMARY']
  if (summaryPath) appendFileSync(summaryPath, `${report.summary}\n`)
  else console.log(report.summary)

  process.exit(1)
}

main()
