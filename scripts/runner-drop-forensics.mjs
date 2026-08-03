#!/usr/bin/env node
/**
 * Was this red check a fleet fault, or did a gate actually reject the change?
 * (#1021)
 *
 * ## The problem this closes
 *
 * A self-hosted job dies mid-run and GitHub reports a plain red check. The job
 * log is a **404** by the time anyone looks, because the runner that was
 * uploading it no longer exists. The only surviving trace is a check-run
 * annotation saying the runner "lost communication with the server" — which is
 * equally consistent with a reclaimed spot instance, a starved one, and a
 * network fault. Every occurrence passes on a plain re-run, so the honest
 * reading of a red branch and the lazy one are indistinguishable, and #982
 * showed the estate had been counting these as broken code for months.
 *
 * `isRunnerKill` (in `practices-metrics.mjs`, imported below rather than
 * re-implemented) already answers *"did a runner die?"* from the run's own step
 * conclusions. It cannot answer *"why?"* — and "why" is what decides whether
 * anyone should be looking at the code at all.
 *
 * ## The join nobody had written
 *
 * Two facts make the "why" recoverable without retaining a single job log:
 *
 * 1. **`runner_name` on a self-hosted job is the EC2 instance ID** — literally
 *    `i-0b26948129cfd56f3`. The philips-labs module names runners after the
 *    instance, so GitHub's own API hands you the fleet's primary key.
 * 2. **CloudTrail already records every spot reclamation for 90 days**, as an
 *    `AwsServiceEvent` named `BidEvictedEvent` whose
 *    `serviceEventDetails.instanceIdSet` lists the instances AWS took back.
 *    Nothing had to be enabled; management events are on by default.
 *
 * So the evidence was never actually missing. What was missing was the join.
 * Measured across both fleets and all twelve repos under measurement,
 * 2026-07-07 to 2026-08-03: **22 of 22 runner-killed jobs matched a spot
 * eviction, and none were unexplained.** The cause is reclamation — not
 * starvation, not network — which is why the fleet lever (spot allocation
 * strategy) is the one that moves this number and log retention is not.
 *
 * ## Why the match is time-bounded and not just an ID lookup
 *
 * `biffo-runners` runs **pooled** runners (`enable_ephemeral_runners = false`,
 * forced by a 4KB SSM limit on repo-level JIT configs), so one instance serves
 * several jobs over its life. An eviction proves that instance died once; it
 * does not tell you which of its jobs it was running at the time. Matching on
 * ID alone would blame a reclamation for an unrelated earlier job on the same
 * host that failed honestly.
 *
 * So an eviction counts only when it lands inside the job's own window. All 22
 * observed matches did, comfortably — but the margins differ sharply by fleet,
 * and the difference is worth knowing when reading output from this tool:
 *
 * - `biffo` (pooled, registration-token): the job ends **4–14 seconds** after
 *   the eviction.
 * - `tabsii` (ephemeral, JIT): the job hangs for **~9–10 minutes** before
 *   GitHub gives up on the vanished runner.
 *
 * {@link MATCH_GRACE_MS} exists because of that 4-second floor.
 */

// @ts-check
import { execFileSync } from 'node:child_process'
import { isRunnerKill } from './practices-metrics.mjs'

/**
 * How far outside a job's own start/finish window an eviction may fall and
 * still be counted as the thing that killed it.
 *
 * Zero tolerance is tempting and wrong. The tightest real margin observed was
 * **4 seconds** (`i-0bfec05c84f2a7030`, `biffo-plugin-idea-scout`), so a few
 * seconds of skew between GitHub's clock and CloudTrail's would push a genuine
 * reclamation outside the window.
 *
 * The failure directions are not symmetric, which is what sets the value. Too
 * tight and a reclaimed runner is reported `fleet-fault-unexplained`, sending
 * someone to hunt instance logs that do not exist for a cause already known —
 * the exact wild goose chase this module was written to end. Too loose and,
 * on the pooled fleet only, a reclamation could be credited to a neighbouring
 * job that failed honestly. A minute is far wider than any plausible clock
 * skew and far narrower than the gap between consecutive jobs on one host.
 */
export const MATCH_GRACE_MS = 60_000

/**
 * Verdicts, in the order a reader should care about them.
 *
 * `FLEET_FAULT_UNEXPLAINED` is the interesting one and the reason this returns
 * three values rather than a boolean. It means a runner demonstrably died and
 * AWS did **not** reclaim it — starvation, a network fault, or the runner
 * process being killed. That is the only case where retaining instance-level
 * logs would buy anything, so it is also the trigger for reopening #1021's
 * first checkbox. The corpus currently holds zero of them; if that changes,
 * the conclusion above has an expiry date.
 */
export const VERDICT = {
  /** A gate ran and rejected the change. Look at the code. */
  REAL_FAILURE: 'real-failure',
  /** AWS reclaimed the spot instance mid-job. Nothing to fix in the repo. */
  SPOT_RECLAIMED: 'spot-reclaimed',
  /** The runner died and no eviction explains it. This one needs a human. */
  FLEET_FAULT_UNEXPLAINED: 'fleet-fault-unexplained',
  /** Ran on a GitHub-hosted runner, so there is no fleet to correlate against. */
  NOT_SELF_HOSTED: 'not-self-hosted',
}

/**
 * EC2 instance IDs are `i-` plus 8 or 17 hex digits. A GitHub-hosted job
 * reports something like `GitHub Actions 1000017440` instead, which must not be
 * silently treated as an unmatched instance — "we could not see the input" is
 * not "there was nothing there".
 *
 * @param {string | null | undefined} name a job's `runner_name`
 * @returns {boolean}
 */
export function isInstanceId(name) {
  return typeof name === 'string' && /^i-[0-9a-f]{8}([0-9a-f]{9})?$/.test(name)
}

/**
 * Index CloudTrail's `lookup-events` output by the instances each event killed.
 *
 * The instance IDs are buried two layers deep: `CloudTrailEvent` is a JSON
 * **string** holding the real record, and the IDs live in
 * `serviceEventDetails.instanceIdSet`. The flat `Resources` array that the
 * top-level event carries is empty for this event type, which is the obvious
 * place to look and the wrong one.
 *
 * One event can name several instances — AWS reclaims a whole pool at once, and
 * the largest single event observed took twelve runners in the same second.
 *
 * @param {Array<Record<string, any>>} events the `Events` array from
 *   `aws cloudtrail lookup-events`
 * @returns {Map<string, string>} instance ID to ISO-8601 eviction time
 */
export function parseEvictions(events) {
  const byInstance = new Map()
  for (const event of events ?? []) {
    let record
    try {
      record = JSON.parse(event?.CloudTrailEvent ?? '{}')
    } catch {
      continue
    }
    const at = record?.eventTime
    if (!at) continue
    for (const id of record?.serviceEventDetails?.instanceIdSet ?? []) {
      // Keep the earliest sighting: an instance is reclaimed once, and a
      // duplicate page of results must not move the timestamp.
      const seen = byInstance.get(id)
      if (!seen || Date.parse(at) < Date.parse(seen)) byInstance.set(id, at)
    }
  }
  return byInstance
}

/**
 * Did `evictedAt` fall inside this job's run, allowing for {@link MATCH_GRACE_MS}?
 *
 * A job still running reports `completed_at: null`; treat that as "the window
 * is still open" rather than as a zero-length window that matches nothing.
 *
 * @param {{ started_at?: string | null, completed_at?: string | null }} job
 * @param {string} evictedAt
 * @returns {boolean}
 */
export function evictionKilledJob(job, evictedAt) {
  const evicted = Date.parse(evictedAt)
  if (Number.isNaN(evicted)) return false
  const started = Date.parse(job?.started_at ?? '')
  if (Number.isNaN(started)) return false
  const completedRaw = Date.parse(job?.completed_at ?? '')
  const completed = Number.isNaN(completedRaw) ? Infinity : completedRaw + MATCH_GRACE_MS
  return evicted >= started - MATCH_GRACE_MS && evicted <= completed
}

/**
 * Adjudicate one failed run against the fleet's eviction record.
 *
 * Order matters: {@link isRunnerKill} is consulted **first**, so a run where a
 * gate genuinely failed stays a real failure even if some unrelated instance
 * happened to be reclaimed in the same window. A reclamation is only ever an
 * explanation for a death that the run's own steps already evidence.
 *
 * @param {Array<Record<string, any>>} jobs the run's `jobs` array
 * @param {Map<string, string>} evictions from {@link parseEvictions}
 * @returns {{ verdict: string, jobs: Array<{ name: string, instance: string | null, verdict: string, evictedAt: string | null }> }}
 */
export function adjudicateRun(jobs, evictions) {
  if (!isRunnerKill(jobs)) return { verdict: VERDICT.REAL_FAILURE, jobs: [] }

  const lost = (jobs ?? []).filter((job) => job.conclusion === 'failure')
  const detail = lost.map((job) => {
    const instance = job.runner_name ?? null
    if (!isInstanceId(instance)) {
      return { name: job.name, instance, verdict: VERDICT.NOT_SELF_HOSTED, evictedAt: null }
    }
    const evictedAt = evictions.get(instance) ?? null
    const reclaimed = evictedAt !== null && evictionKilledJob(job, evictedAt)
    return {
      name: job.name,
      instance,
      verdict: reclaimed ? VERDICT.SPOT_RECLAIMED : VERDICT.FLEET_FAULT_UNEXPLAINED,
      evictedAt: reclaimed ? evictedAt : null,
    }
  })

  // The run is only "explained" when every job that died has an eviction behind
  // it. One unexplained death is the whole point of the tool, so it dominates —
  // reporting the run as reclaimed because the *other* three jobs were would
  // bury exactly the case that needs a person.
  const explained = detail.every((d) => d.verdict === VERDICT.SPOT_RECLAIMED)
  return {
    verdict: explained ? VERDICT.SPOT_RECLAIMED : VERDICT.FLEET_FAULT_UNEXPLAINED,
    jobs: detail,
  }
}

/**
 * Roll a set of adjudicated runs into the counts a human wants to read.
 *
 * @param {Array<{ verdict: string }>} runs
 * @returns {Record<string, number>}
 */
export function summarise(runs) {
  const counts = {
    [VERDICT.REAL_FAILURE]: 0,
    [VERDICT.SPOT_RECLAIMED]: 0,
    [VERDICT.FLEET_FAULT_UNEXPLAINED]: 0,
    [VERDICT.NOT_SELF_HOSTED]: 0,
  }
  for (const run of runs ?? []) counts[run.verdict] = (counts[run.verdict] ?? 0) + 1
  return counts
}

// ---------------------------------------------------------------------------
// I/O. Everything above is pure so the CLI's vitest suite can exercise it
// without a network; everything below is the thin shell that feeds it.
// ---------------------------------------------------------------------------

/** @param {string[]} args */
function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }))
}

/**
 * Fetch the fleet's eviction record.
 *
 * `lookup-events` pages at 50 regardless of `--max-results`, so this leans on
 * the AWS CLI's own `--no-paginate`-free default, which follows `NextToken` to
 * exhaustion. Asking for 1000 in one call silently returns 50 and looks like a
 * quiet fleet — the first draft of this reported `tabsii` at 50 evictions when
 * the true figure was 141.
 *
 * @param {{ profile: string, region: string, since: string }} opts
 */
function fetchEvictions({ profile, region, since }) {
  const out = execFileSync(
    'aws',
    [
      'cloudtrail',
      'lookup-events',
      '--profile',
      profile,
      '--region',
      region,
      '--lookup-attributes',
      'AttributeKey=EventName,AttributeValue=BidEvictedEvent',
      '--start-time',
      since,
      '--output',
      'json',
      '--no-cli-pager',
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  return parseEvictions(JSON.parse(out).Events ?? [])
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { repo: null, run: null, profile: 'default', region: 'us-east-2', since: null }
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i]
    if (argv[i] === '--repo') args.repo = next()
    else if (argv[i] === '--run') args.run = next()
    else if (argv[i] === '--profile') args.profile = next()
    else if (argv[i] === '--region') args.region = next()
    else if (argv[i] === '--since') args.since = next()
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.repo || !args.run) {
    console.error(
      'usage: runner-drop-forensics.mjs --repo <owner/name> --run <run-id> [--profile <aws-profile>] [--region <region>] [--since <date>]\n\n' +
        'Decides whether a red check was a fleet fault or a real failure, by joining the\n' +
        "run's self-hosted jobs to CloudTrail's record of spot reclamations.",
    )
    process.exit(2)
  }

  const jobs = gh([
    'api',
    `repos/${args.repo}/actions/runs/${args.run}/jobs?per_page=100`,
    '--paginate',
    '--slurp',
  ]).flatMap((/** @type {any} */ page) => page.jobs ?? [])

  // Default the lookback to a day before the run started. CloudTrail keeps 90
  // days of management events, so a wider window costs only latency, but there
  // is no reason to page through three months to explain this morning.
  const started = jobs.map((/** @type {any} */ j) => j.started_at).filter(Boolean).sort()[0]
  const since =
    args.since ?? new Date(Date.parse(started ?? new Date().toISOString()) - 86_400_000).toISOString()

  const evictions = fetchEvictions({ profile: args.profile, region: args.region, since })
  const result = adjudicateRun(jobs, evictions)

  console.log(`run ${args.run} in ${args.repo}: ${result.verdict}`)
  for (const job of result.jobs) {
    const because = job.evictedAt ? `  (AWS reclaimed it at ${job.evictedAt})` : ''
    console.log(`  ${job.verdict.padEnd(24)} ${job.instance ?? '—'}  ${job.name}${because}`)
  }

  // The estate's three-valued contract, and the mapping is not arbitrary:
  // 0 the drop is explained and a plain re-run is justified; 1 a gate rejected
  // the change, so go and read the code; 2 CANNOT TELL — a runner demonstrably
  // died and nothing accounts for it.
  //
  // `fleet-fault-unexplained` earns 2 rather than a bespoke code precisely
  // because **2 is never a pass** here as everywhere else. "The runner died for
  // reasons unknown" must not read as "safe to re-run and move on"; that is the
  // fail-open this whole tool exists to close.
  if (result.verdict === VERDICT.REAL_FAILURE) process.exit(1)
  if (result.verdict === VERDICT.SPOT_RECLAIMED) process.exit(0)
  process.exit(2)
}

if (process.argv[1] && process.argv[1].endsWith('runner-drop-forensics.mjs')) {
  main()
}
