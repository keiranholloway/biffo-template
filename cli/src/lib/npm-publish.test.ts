import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  classifyPublishFailure,
  describePublishFailure,
  logTail,
  type PublishAttempt,
} from './npm-publish.js'

/**
 * The logs below are npm's real output shapes, not paraphrases. The whole point
 * of this module is that it reads what npm actually prints — a classifier
 * tested against invented strings would agree with itself and nothing else.
 *
 * npm rewrote its error prefix from `npm ERR!` to `npm error` in v10, and both
 * are still in circulation, so both are represented.
 */

/** The #342 failure, verbatim in shape: npm 10+, publishing over an existing version. */
const ALREADY_PUBLISHED = `
npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access
npm error code E403
npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@biffo%2fcli - You cannot publish over the previously published versions: 0.41.9.
npm error 403 In most cases, you or one of your dependencies are requesting
npm error 403 a package version that is forbidden by your security policy, or
npm error 403 on a server you do not have access to.
`

/** Same failure on npm 9 and earlier. */
const ALREADY_PUBLISHED_LEGACY = `
npm ERR! code E403
npm ERR! 403 403 Forbidden - PUT https://registry.npmjs.org/@biffo%2fcli - You cannot publish over the previously published versions: 0.41.9.
`

const NEEDS_AUTH = `
npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in to https://registry.npmjs.org/
npm error need auth You need to authorize this machine using \`npm adduser\`
`

const UNAUTHORIZED = `
npm error code E401
npm error 401 Unauthorized - PUT https://registry.npmjs.org/@biffo%2fcli
`

const REGISTRY_DOWN = `
npm error code E500
npm error 500 Internal Server Error - PUT https://registry.npmjs.org/@biffo%2fcli
`

const NETWORK = `
npm error code ECONNRESET
npm error network request to https://registry.npmjs.org/@biffo%2fcli failed, reason: socket hang up
npm error network This is a problem related to network connectivity.
`

describe('classifyPublishFailure', () => {
  it('recognises npm 10+ "cannot publish over the previously published versions"', () => {
    expect(classifyPublishFailure(ALREADY_PUBLISHED)).toBe('already-published')
  })

  it('recognises the same failure from npm 9 and earlier', () => {
    // The runner's npm version is not this module's business to track.
    expect(classifyPublishFailure(ALREADY_PUBLISHED_LEGACY)).toBe('already-published')
  })

  it('recognises a registry that answers EPUBLISHCONFLICT instead', () => {
    expect(classifyPublishFailure('npm error code EPUBLISHCONFLICT')).toBe('already-published')
  })

  it('does not read an already-published 403 as an auth problem', () => {
    // Load-bearing ordering, and genuinely ambiguous input: npm returns 403 for
    // BOTH "that version exists" and "you may not publish this package", and the
    // already-published body ends with the boilerplate "…on a server you do not
    // have access to" — which matches the auth patterns outright. Only the order
    // of the two checks separates them. Reading this as auth would send someone
    // to rotate a perfectly good token while the release stayed broken.
    expect(ALREADY_PUBLISHED).toMatch(/do not have access/)
    expect(classifyPublishFailure(ALREADY_PUBLISHED)).toBe('already-published')
  })

  it('does read a genuine no-rights 403 as an auth problem', () => {
    // The other side of that overlap: same status code, no publish-over wording.
    const forbidden = `
npm error code E403
npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@biffo%2fcli - You do not have permission to publish "@biffo/cli". Are you logged in as the correct user?
`
    expect(classifyPublishFailure(forbidden)).toBe('auth')
  })

  it('recognises a missing or expired token', () => {
    expect(classifyPublishFailure(NEEDS_AUTH)).toBe('auth')
    expect(classifyPublishFailure(UNAUTHORIZED)).toBe('auth')
  })

  it('leaves a registry outage and a network drop as retryable unknowns', () => {
    expect(classifyPublishFailure(REGISTRY_DOWN)).toBe('unknown')
    expect(classifyPublishFailure(NETWORK)).toBe('unknown')
  })

  it('classifies an empty log as unknown, not as already-published', () => {
    // Fail towards "retry is safe": nothing was published, so nothing is lost
    // by trying again. Guessing "already published" on no evidence would
    // announce a release-integrity incident that never happened.
    expect(classifyPublishFailure('')).toBe('unknown')
  })
})

describe('logTail', () => {
  it('keeps the end, where npm puts the cause', () => {
    const log = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    const tail = logTail(log, 5)
    expect(tail).toContain('line 59')
    expect(tail).not.toContain('line 54')
  })

  it('drops blank lines and survives a short log', () => {
    expect(logTail('a\n\n\nb\n')).toBe('a\nb')
  })
})

describe('describePublishFailure', () => {
  const attempt = (over: Partial<PublishAttempt> = {}): PublishAttempt => ({
    packageName: '@biffo/cli',
    version: '0.41.9',
    tag: 'core-v0.41.9',
    commit: '0801b17aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    log: ALREADY_PUBLISHED,
    registryGitHead: null,
    ...over,
  })

  describe('already published', () => {
    it('says re-running cannot work, so nobody burns an afternoon on it', () => {
      // The distinction the whole step exists to draw: this is not a flake.
      const report = describePublishFailure(attempt())
      expect(report.kind).toBe('already-published')
      expect(report.annotations.join(' ')).toMatch(/cannot succeed|do NOT retry/)
      expect(report.summary).toContain('immutable')
    })

    it('names the version, the tag and the issue', () => {
      const report = describePublishFailure(attempt())
      const text = `${report.annotations.join(' ')} ${report.summary}`
      expect(text).toContain('@biffo/cli@0.41.9')
      expect(text).toContain('core-v0.41.9')
      expect(text).toContain('#342')
    })

    it('prescribes bumping core.version, never repointing the tag', () => {
      // Same rule as sync-core-tag's refusal: the artifact cannot follow the
      // tag, so the tag must not chase the artifact.
      const report = describePublishFailure(attempt())
      expect(report.summary).toContain('core.version')
      expect(report.summary).toMatch(/Never re-?point/i)
    })

    it('calls the tag and the registry a disagreement when gitHead differs', () => {
      const report = describePublishFailure(
        attempt({ registryGitHead: 'deadbeefcafebabe000000000000000000000000' }),
      )
      expect(report.annotations.join(' ')).toContain('different trees')
      expect(report.summary).toContain('deadbeef')
      expect(report.summary).toContain('0801b17a')
    })

    it('says the release is intact when gitHead matches the tag commit', () => {
      // The benign case — a manual re-dispatch of a tag that already published.
      // Still red, because this run published nothing, but the reader must not
      // be sent chasing a corruption that is not there.
      const commit = '0801b17aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const report = describePublishFailure(attempt({ commit, registryGitHead: commit }))
      expect(report.summary).toContain('release is intact')
      expect(report.annotations.join(' ')).toContain('duplicate')
    })

    it('refuses to guess when the registry reports no gitHead', () => {
      // Absent evidence is not evidence of agreement.
      const report = describePublishFailure(attempt({ registryGitHead: null }))
      expect(report.summary).toContain('not reported')
      expect(report.annotations.join(' ')).toContain('disagreeing until proven otherwise')
      expect(report.summary).not.toContain('release is intact')
    })
  })

  describe('auth', () => {
    it('sends the reader to the trusted-publisher registration, not to a token', () => {
      const report = describePublishFailure(attempt({ log: NEEDS_AUTH }))
      expect(report.kind).toBe('auth')
      expect(report.annotations.join(' ')).toContain('Trusted Publisher')
      expect(report.summary).toContain('re-run is safe')
      // The old advice was "mint a fresh automation token" — there is no token
      // any more, and following it sends the reader somewhere that cannot help.
      expect(report.annotations.join(' ')).not.toContain('automation token')
    })

    it('warns that a bare re-run will not help, and names the 404-means-403 trap', () => {
      // Three consecutive re-dispatches were burned on this in #664: npm answers
      // 404 on an unauthorised PUT so as not to reveal whether a private package
      // exists, which reads as "no such package" when it means "not allowed".
      const report = describePublishFailure(attempt({ log: NEEDS_AUTH }))
      expect(report.summary).toContain('will not help')
      expect(report.summary).toContain('404')
      expect(report.summary).toContain('11.5.1')
    })
  })

  describe('unknown', () => {
    it('says retrying is safe and shows npm’s own words', () => {
      const report = describePublishFailure(attempt({ log: NETWORK }))
      expect(report.kind).toBe('unknown')
      expect(report.annotations.join(' ')).toContain('NOT')
      expect(report.summary).toContain('socket hang up')
      expect(report.summary).toContain('safe')
    })
  })

  it('never advises a retry that cannot succeed', () => {
    // The one cross-cutting property: "retry" and "already published" must
    // never appear together, in either direction. Getting this backwards is how
    // a release-integrity failure gets mistaken for a bad afternoon on npm.
    const published = describePublishFailure(attempt())
    expect(`${published.annotations.join(' ')} ${published.summary}`).not.toMatch(
      /re-?dispatch this workflow|is safe/i,
    )
    for (const log of [NEEDS_AUTH, NETWORK, REGISTRY_DOWN]) {
      const report = describePublishFailure(attempt({ log }))
      expect(report.summary).not.toContain('immutable')
    }
  })
})

/**
 * End-to-end over the script the workflow actually calls, because the wiring is
 * where this can quietly stop working: a report that classifies perfectly but
 * exits 0, or writes nowhere, is the #342 failure again in a new coat.
 */
describe('report-publish-failure script', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const script = join(here, '../scripts/report-publish-failure.ts')
  const tsx = join(resolve(here, '../../..'), 'cli/node_modules/.bin/tsx')

  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'biffo-publish-report-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const run = (env: Record<string, string>, log = ALREADY_PUBLISHED) => {
    const logPath = join(dir, 'npm.log')
    const summaryPath = join(dir, 'summary.md')
    writeFileSync(logPath, log)
    writeFileSync(summaryPath, '')
    try {
      const out = execFileSync(tsx, [script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PUBLISH_LOG: logPath,
          GITHUB_STEP_SUMMARY: summaryPath,
          ...env,
        },
      })
      return { code: 0, out, summary: readFileSync(summaryPath, 'utf8') }
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string }
      return {
        code: e.status,
        out: `${e.stdout}${e.stderr}`,
        summary: readFileSync(summaryPath, 'utf8'),
      }
    }
  }

  const env = {
    PUBLISH_PACKAGE: '@biffo/cli',
    PUBLISH_VERSION: '0.41.9',
    PUBLISH_TAG: 'core-v0.41.9',
    PUBLISH_COMMIT: '0801b17aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }

  it('fails the job and annotates the run, not just the log', () => {
    // ::error:: puts this on the run's summary page. The log line npm already
    // printed is exactly what nobody read in #342.
    const { code, out } = run(env)
    expect(code).toBe(1)
    expect(out).toContain('::error::')
    expect(out).toContain('already on the npm registry')
  })

  it('writes the detail to the job summary', () => {
    const { summary } = run(env)
    expect(summary).toContain('is already published')
    expect(summary).toContain('core-v0.41.9')
  })

  it('keeps every annotation on one line', () => {
    // GitHub truncates an annotation at the first newline, so a wrapped message
    // would lose its remedy — the half that matters.
    const { out } = run(env)
    const annotations = out.split('\n').filter((l) => l.startsWith('::error::'))
    expect(annotations.length).toBeGreaterThan(1)
    for (const line of annotations) expect(line).not.toMatch(/\s{2,}/)
  })

  it('passes the registry gitHead through to the verdict', () => {
    const { summary } = run({ ...env, PUBLISH_REGISTRY_GIT_HEAD: env.PUBLISH_COMMIT })
    expect(summary).toContain('release is intact')
  })

  it('treats an empty gitHead as unknown rather than a match', () => {
    // The workflow sets this from `npm view … || true`, so "" is what an
    // outage looks like. It must not read as agreement.
    const { summary } = run({ ...env, PUBLISH_REGISTRY_GIT_HEAD: '   ' })
    expect(summary).toContain('not reported')
  })

  it('still fails when npm’s log is missing entirely', () => {
    const { code, out } = run({ ...env, PUBLISH_LOG: join(dir, 'nope.log') })
    expect(code).toBe(1)
    expect(out).toContain('::error::')
  })
})
