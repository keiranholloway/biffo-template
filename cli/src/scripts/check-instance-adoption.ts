/**
 * CI entrypoint for the instance-adoption check (#1538/#1570/#1609): does a
 * REAL instance's tree consume the registered adoption channels — the ones
 * `checkInstanceAdoption` (`../lib/instance-adoption.js`) already knows how to
 * detect — without anyone having to run `biffo core upgrade` by hand?
 *
 * ── The gap this closes ─────────────────────────────────────────────────
 *
 * `checkInstanceAdoption` had exactly one caller before this file existed:
 * `cli/src/commands/core-upgrade.ts`, inside `runCoreUpgradeResolved`. That
 * means the detector — built specifically to catch a template-owned file
 * distributing correctly while the user-owned line that makes it DO anything
 * stays unwritten (#1538) — only ever ran when an operator happened to invoke
 * an upgrade against that exact instance. `keiranholloway/biffo-platform`
 * carried the undetected gap for three days (PR #174) before anyone looked;
 * nothing would have shortened that window, because nothing was watching
 * between upgrades. This is the "third audit nobody runs" shape (#1413): a
 * guard with a real, correct mechanism and zero callers outside one manual
 * path is functionally no guard at all for every instance nobody happens to
 * be upgrading today.
 *
 * This entrypoint is the missing caller: `instance-adoption-report.yml`
 * clones each live core instance fresh and invokes this against it on a
 * schedule, the same shape `check-core-direct-paths.ts` established for
 * `core-direct-paths-report.yml` (#1377) — clone the real tree, run the
 * existing pure-logic checker against it, fail loud, state the denominator.
 *
 * ── What this does NOT check by default ─────────────────────────────────
 *
 * There is no self-check default here, unlike `core-direct-paths`'s
 * skeleton-against-itself fallback. `biffo-template` IS the template — it has
 * no instance tree of its own to examine, and a fabricated one would prove
 * nothing about a real gap. `--instance-dir` is required; omitting it fails
 * loud (exit 2 — cannot tell, not a pass) rather than silently skipping.
 *
 * ── Exit codes ────────────────────────────────────────────────────────────
 *
 * 0 — every applicable registered pair is adopted (or none are applicable —
 *     that is `not-applicable`, not a gap). 1 — at least one applicable pair
 * is unadopted: a real, actionable finding, not pre-existing residue to
 * tolerate — `checkInstanceAdoption` only ever reports a pair as applicable
 * once the target tree actually ships the channel, so an unadopted finding
 * here is always something an instance operator can act on today. 2 —
 * `--instance-dir` missing, so nothing was examined at all.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { checkInstanceAdoption } from '../lib/instance-adoption.js'

export interface InstanceAdoptionCheckOptions {
  /** Label for the report — defaults to the basename of --instance-dir. */
  instance?: string
  /** REQUIRED: the real instance tree to examine (`oursDir`). No self-check
   * default exists — see the module doc comment for why. */
  instanceDir?: string
  /** The template tree that ships the channel (`theirsDir`). Defaults to this
   * checkout's own root, i.e. "does the CURRENT template ship a channel this
   * instance hasn't consumed?" — the question a scheduled report actually
   * wants answered, as opposed to core-upgrade's per-invocation target. */
  theirsDir?: string
}

export async function runInstanceAdoptionCheck(
  opts: InstanceAdoptionCheckOptions = {},
): Promise<void> {
  if (!opts.instanceDir) {
    console.error(
      '✗ instance-adoption guard: --instance-dir is required — the real instance tree to ' +
        'check adoption against. There is no self-check default: this repo IS the template, ' +
        'it has no instance tree of its own to examine, and a fabricated one would prove ' +
        'nothing about a real gap.',
    )
    process.exit(2)
  }

  if (!existsSync(opts.instanceDir)) {
    console.error(
      `✗ instance-adoption guard: --instance-dir ${opts.instanceDir} does not exist — cannot ` +
        'tell whether it is adopted, and that is not the same as a clean pass.',
    )
    process.exit(2)
  }

  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
  const theirsDir = opts.theirsDir ?? root
  const instanceLabel = opts.instance ?? join(opts.instanceDir).split('/').filter(Boolean).pop()

  const report = checkInstanceAdoption(theirsDir, opts.instanceDir)

  // Denominator first, unconditionally, same discipline as
  // check-core-direct-paths.ts: a clean run that never says how much it
  // looked at is indistinguishable from one that looked at nothing (#1363).
  console.log(
    `examined ${report.examinedInstances} instance (${instanceLabel}) against ` +
      `${report.registeredPairs} registered pair(s), ${report.applicablePairs} applicable to ` +
      `this instance, against template tree ${theirsDir}`,
  )

  const unadopted = report.findings.filter((f) => f.status === 'unadopted')
  if (unadopted.length === 0) {
    console.log(`✓ instance-adoption guard (${instanceLabel}): no adoption gaps`)
    return
  }

  console.error(
    `✗ instance-adoption guard (${instanceLabel}): ${unadopted.length} adoption gap(s) — ` +
      'shipped but not consumed (#1538/#1570):',
  )
  for (const f of unadopted) {
    console.error(`  ${f.pair.id} — ${f.pair.userFile} does not consume ${f.pair.templateFile}`)
    console.error(`    ${f.pair.remedy}`)
  }
  console.error('\nSee biffo-template#1538/#1570/#1609.')
  process.exit(1)
}
