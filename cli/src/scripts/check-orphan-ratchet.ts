/**
 * CI entrypoint for the #1026 orphan ratchet / unsanctioned-file guard
 * (`checkOrphanRatchet` + `planCoreUpgrade`'s `classify`, both in
 * `../lib/core-upgrade.js`).
 *
 * ── The gap this closes ─────────────────────────────────────────────────
 *
 * `checkOrphanRatchet` had exactly one caller before this file existed:
 * `cli/src/commands/core-upgrade.ts`. That means an instance can accumulate
 * unsanctioned files under a template-owned path — a script, a test, a
 * config — for as long as nobody happens to run `biffo core upgrade`, and the
 * first anyone hears of it is the upgrade refusing to proceed, months and
 * dozens of core versions after the file was added, with the reasoning for
 * why it was added long gone (biffo-template#1714). Measured on
 * `tabsii-platform` 2026-08-23: 21 unsanctioned files against a baseline of
 * 18, the baseline itself three weeks and ~90 core versions stale, because
 * nothing had run this check since. This is the same "third audit nobody
 * runs" shape as `check-instance-adoption.ts` (#1413) and
 * `check-core-direct-paths.ts` (#1377): a guard with a correct mechanism and
 * one caller, reachable only by the operation it exists to unblock.
 *
 * ── What the self-check default does NOT prove, and why it exists anyway ──
 *
 * `classify()`'s `orphaned` flag is set ONLY on a path present in `oursDir`
 * but absent from BOTH `baseDir` and `theirsDir`. When `--instance-dir` is
 * left unset it defaults to `--theirs-dir` (itself defaulted to this repo's
 * own root), and `--base-dir` defaults to `--theirs-dir` too — so every path
 * examined is by construction also present in `theirsDir`: they are literally
 * the same files, read twice. Nothing can ever be "absent from theirs". The
 * result is mathematically forced to be zero orphans, always, regardless of
 * what the checked-out tree actually contains: there is no second, diverged
 * tree for `biffo-template` to compare itself against.
 *
 * `check-instance-adoption.ts` refuses to default for exactly this reason —
 * "a fabricated [tree] would prove nothing about a real gap" — and that is
 * the right call for a guard that runs out-of-band and could be mistaken for
 * a real pass. This guard differs in where it needs to run: #1714 asks for it
 * wired into `.github/workflows/ci.yml` on every PR, and every sibling guard
 * that file invokes runs as a bare `sh scripts/biffo.sh check <name>` with no
 * arguments — `check.test.ts`'s `assertRunsCommand` enforces that shape
 * exactly, so it can catch a guard silently renamed out of the workflow
 * (#720). A required `--instance-dir` would make the per-PR step either fail
 * outright or need arguments no other guard in that file carries. So the
 * default here is deliberate and loudly self-aware rather than refused: every
 * self-check run prints that it is one and why it can only ever find zero
 * (below). It proves the CLI wiring, exit codes and the per-file guidance
 * work correctly in real CI, and gives an instance an already-exercised
 * command to point at its own tree. It can never itself catch the drift
 * #1714 was filed over — that requires this same command, with
 * `--instance-dir` pointed at a REAL instance tree. That caller now exists:
 * `.github/workflows/orphan-ratchet-report.yml` clones every live instance
 * fresh on a schedule and runs exactly this invocation against each one's
 * real tree, mirroring `instance-adoption-report.yml`'s shape for the
 * sibling guard it was modelled on. This self-check step in ci.yml stays as
 * it is — it proves the CLI path on every PR — but it is no longer the only
 * caller this command has.
 *
 * A second, later verdict on #1714 (2026-09-04) found that neither of those
 * two callers blocks the PR that actually CREATES the divergence: the
 * scheduled report only runs from the template's own schedule, up to a day
 * after an instance PR merges, and every instance's own copy of this
 * self-check step is — by the same "all three dirs default to the same
 * root" construction above — ALSO permanently zero, once distributed into
 * an instance's ci.yml via the ordinary `biffo core upgrade` three-way
 * merge, because it still runs with no `--instance-dir`. `scripts/
 * check-orphan-ratchet-instance.sh` is the third caller that closes that
 * gap: it runs from an instance's own PR-time CI, resolves a real template
 * tree by cloning `biffo-template` at that instance's own recorded
 * `biffo.core.json` version, and passes it as BOTH `--theirs-dir` and
 * `--base-dir` — see that script's own doc comment for the full reasoning.
 *
 * ── The per-file guidance (#1714) ────────────────────────────────────────
 *
 * The refusal inside `biffo core upgrade` used to name only a bare count and
 * a list of paths, leaving the author to work out where a flagged file
 * SHOULD live by re-reading `core-manifest.json` by hand. Every orphan report
 * here also names, via `explainOwnership` (`../lib/core-manifest.js`):
 *   - the `templateOwned` entry currently claiming the path, and
 *   - the nearest `userOwned` entry(ies) — sharing the longest run of literal
 *     leading path segments — if any exist at all.
 *
 * That is structural proximity, not a semantic verdict. It cannot distinguish
 * "this file belongs in an existing carve-out a few segments over" from "this
 * file is a core capability that was written into the wrong repo and belongs
 * upstream in biffo-template instead" — both look identical from here: a path
 * with no `userOwned` entry covering it. #1714 asks for that distinction only
 * where the existing `classify()`/`isTemplateOwned()` logic can already make
 * it; it cannot today, so this reports the structural fact and leaves the
 * semantic call to the reader — see the module-level explanation in
 * `core-manifest.ts` for why inventing a heuristic here was deliberately
 * avoided rather than silently dropped.
 *
 * ── Exit codes ────────────────────────────────────────────────────────────
 *
 * 0 — zero orphans (including every self-check run), or a baseline exists and
 *     the live count did not increase (checkOrphanRatchet's ratchet
 *     semantics: pre-existing residue never fails, only growth does).
 *     1 — the count increased over a recorded baseline: a real, actionable
 *     finding, only reachable with an explicit `--instance-dir` pointed at a
 *     real, diverged tree. 2 — `--instance-dir` was given explicitly but does
 *     not exist, so nothing was examined at all — cannot-tell, never a pass.
 */
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { execa } from '../lib/exec.js'
import { explainOwnership, readCoreManifest } from '../lib/core-manifest.js'
import {
  checkOrphanRatchet,
  planCoreUpgrade,
  readOrphanBaseline,
  type MergeEntry,
} from '../lib/core-upgrade.js'

export interface OrphanRatchetCheckOptions {
  /** The real instance tree to check (`oursDir`). Defaults to `--theirs-dir`
   * (itself defaulted to this repo's own root) — a SELF-CHECK that can only
   * ever report zero orphans, by construction; see this module's doc comment
   * for why that default exists anyway and is not a silent no-op. Pass a real
   * instance checkout for the check to mean anything. */
  instanceDir?: string
  /** Template tree that defines ownership (`theirsDir`). Defaults to this
   * checkout's own root. */
  theirsDir?: string
  /** Merge-base template tree (`baseDir`) — the template at the instance's
   * CURRENT core version. Defaults to `--theirs-dir`, which is only correct
   * when the instance is already on the latest version; a real drift check
   * against an instance behind the template should pass this explicitly. */
  baseDir?: string
  /** Label for the report; defaults to the basename of `--instance-dir`. */
  label?: string
}

function reportOrphan(entry: MergeEntry, manifest: ReturnType<typeof readCoreManifest>): void {
  console.error(`  ${entry.path}`)
  const { templateOwnedMatch, nearestUserOwnedEntries } = explainOwnership(entry.path, manifest)
  console.error(
    `    claimed by templateOwned entry: ${templateOwnedMatch ?? '(none — unexpected)'}`,
  )
  if (nearestUserOwnedEntries.length > 0) {
    console.error(`    nearest sanctioned carve-out(s): ${nearestUserOwnedEntries.join(', ')}`)
    console.error(
      '    — move it under one of those, OR add it to biffo.divergence.json with a ' +
        'Core-Divergence trailer if it belongs there permanently.',
    )
  } else {
    console.error(
      '    no userOwned entry shares any leading path segment with this file — ' +
        'core-manifest.json has no carve-out anywhere near it today.',
    )
    console.error(
      '    Either this is a core capability that belongs upstream in biffo-template, or it ' +
        'needs a new carve-out declared in core-manifest.json. classify()/isTemplateOwned() ' +
        "cannot tell those apart automatically (#1714) — that judgement is the author's.",
    )
  }
}

export async function runOrphanRatchetCheck(opts: OrphanRatchetCheckOptions = {}): Promise<void> {
  // Only an EXPLICITLY given --instance-dir can be wrong in a way worth
  // stopping for — an omitted one deliberately falls through to the
  // self-check default below, so there is nothing to validate yet.
  if (opts.instanceDir !== undefined && !existsSync(opts.instanceDir)) {
    console.error(
      `✗ orphan-ratchet guard: --instance-dir ${opts.instanceDir} does not exist — cannot tell ` +
        'whether it carries unsanctioned files, and that is not the same as a clean pass.',
    )
    process.exit(2)
    return
  }

  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
  const theirsDir = opts.theirsDir ?? root
  const instanceDir = opts.instanceDir ?? theirsDir
  const baseDir = opts.baseDir ?? theirsDir
  const label = opts.label ?? (basename(instanceDir) || instanceDir)

  if (instanceDir === theirsDir && baseDir === theirsDir) {
    console.log(
      'self-check mode: --instance-dir was not given, so it defaulted to --theirs-dir (this ' +
        "repo's own root) alongside --base-dir — all three trees are the same, so this run " +
        "can only ever find zero orphans by construction. See this script's doc comment. " +
        'Pass a real instance tree with --instance-dir for a check that can actually find ' +
        'something. biffo-template#1714.',
    )
  }

  const manifest = readCoreManifest(theirsDir)
  const plan = await planCoreUpgrade({ baseDir, oursDir: instanceDir, theirsDir, manifest })
  const baseline = readOrphanBaseline(instanceDir)
  const ratchet = checkOrphanRatchet(plan.orphaned.length, baseline)

  // Denominator first, unconditionally — same discipline as
  // check-instance-adoption.ts and check-core-direct-paths.ts: a clean run
  // that never says how much it looked at is indistinguishable from one that
  // looked at nothing (#1363).
  //
  // `plan.entries.length` — not `plan.orphaned.length` — is the true
  // denominator: it is every template-owned path `classify()` considered
  // (the union of paths present in base/ours/theirs, per `planCoreUpgrade`),
  // while `plan.orphaned.length` is only the subset flagged. Printing the
  // orphan count under "examined" reads as a total-considered figure but is
  // actually the finding count restated — indistinguishable, on its face,
  // from a run that only ever considered the flagged paths in the first
  // place (biffo-template#1844).
  console.log(
    `examined ${label}: ${plan.entries.length} template-owned path(s) considered, ` +
      `${plan.orphaned.length} unsanctioned file(s) found ` +
      `(baseline ${baseline === null ? 'none recorded' : String(baseline.count)}), ` +
      `against template tree ${theirsDir}`,
  )

  if (plan.orphaned.length === 0) {
    console.log(`✓ orphan-ratchet guard (${label}): no unsanctioned files`)
    return
  }

  console.error(
    `${ratchet.increased ? '✗' : '·'} orphan-ratchet guard (${label}): ` +
      `${String(plan.orphaned.length)} unsanctioned instance file(s) under a template-owned ` +
      `path (#1026)${ratchet.increased ? ' — INCREASED over the recorded baseline' : ''}:`,
  )
  for (const entry of plan.orphaned) reportOrphan(entry, manifest)

  if (ratchet.increased) {
    console.error(
      `\nbaseline was ${String(ratchet.baseline)}, now ${String(ratchet.count)}. See ` +
        'biffo-template#1026 and biffo-template#1714.',
    )
    process.exit(1)
  }
}
