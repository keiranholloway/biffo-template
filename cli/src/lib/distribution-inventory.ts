import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The #1570 class: this estate has several independent channels that carry a
 * change from one repo to N others -- `filesFromSkeleton`, the other five
 * `shared-files.json` lists, `core-manifest.json`'s `templateOwned` boundary
 * (distributed via `biffo core upgrade`), and the instance-adoption pair
 * registry (`instance-adoption.ts`, #1538/#1609). Each grew its own drift
 * detector independently, or none, and nothing before this file answered
 * "which artifacts must travel, by which channel, and is each one currently
 * checked?" -- so a registration gap (#1570's sub-shape (a): the channel
 * exists, the artifact was simply never registered with it) was invisible to
 * every existing detector at once, because a detector only ever compares the
 * copies it already knows about.
 *
 * ## What this file is, and is not
 *
 * `distribution-inventory.json` (repo root, alongside `core-manifest.json`
 * and `shared-files.json`) is the registry: one entry per artifact that must
 * travel, naming its channel and (where one exists) the real detector that
 * already checks it. This module loads and validates that registry and
 * exposes the pieces `distribution-inventory.test.ts` needs to sweep it.
 *
 * This is deliberately NOT a new per-channel comparator. #1570 argues at
 * length that one more per-channel detector does not close this class --
 * only an inventory plus a sweep that reads it does. So every entry here
 * either points at a detector that already exists elsewhere in this repo
 * (`claim-invocation-parity.ts`, `scripts/shared-sync.sh`,
 * `instance-adoption.ts`) or is honestly marked `unverified` with a stated
 * `gapReason` -- never a hand-rolled comparison invented for this file.
 *
 * ## Two different kinds of "current"
 *
 * A registered channel's detector either:
 *
 * - **`selfCheckable`** -- can run against THIS checkout alone (no other
 *   repo's tree required). `claim-invocation-parity.ts`'s `AGENTS.md` copies
 *   all live in this repo (root plus every skeleton's own AGENTS.md), so the
 *   sweep test calls the real detector and asserts it currently passes. This
 *   is a live, load-bearing assertion -- it fails the moment the guard it
 *   wraps regresses.
 * - **not self-checkable** -- needs a real satellite or instance tree this
 *   repo's own CI cannot see (`shared-sync.sh --check --estate <dir>`,
 *   `check instance-adoption --instance-dir <dir>`). For these the sweep can
 *   only verify the detector's command is actually wired into a scheduled
 *   workflow -- i.e. that the channel's plumbing is live, not that every
 *   remote copy is clean right now. That currency lives in the named
 *   workflow's own run history (`shared-sync-report.yml`,
 *   `instance-adoption-report.yml`), not here. Claiming otherwise would be
 *   exactly the "reports a denominator it never printed" shape (#1363) this
 *   estate is already trying to eliminate.
 *
 * An entry with no detector at all (`status: "unverified"`, channel `"none"`)
 * is a real, named gap -- #1570 sub-shape (a) with no channel yet, or
 * sub-shape (c) where no channel can exist without a separate architectural
 * decision (build skills, #1526). Recording it here IS the fix in that case;
 * inventing a channel to make the row look green would be worse than leaving
 * it red, because it would hide exactly the thing #1570 was filed to surface.
 */

export type ChannelId =
  | 'filesFromSkeleton'
  | 'sharedFilesSync'
  | 'templateOwnedCoreUpgrade'
  | 'instanceAdoptionPair'
  | 'none'

export interface ChannelDefinition {
  description: string
  detectorCommand: string | null
  detectorImplementation: string | null
  selfCheckable: boolean
  selfCheckableReason?: string
  scope?: string
  wiredIn: string | null
}

/**
 * Three states, not two:
 *
 * - `detected` -- a real detector exists for exactly this artifact and
 *   currently reports it clean (or, for a non-self-checkable channel, is
 *   verifiably wired into a scheduled workflow).
 * - `unregistered` -- the CHANNEL's mechanism genuinely exists (a real
 *   `detectorCommand`), but it is not systematically applied to THIS
 *   artifact: either the artifact was never added to a per-item registry the
 *   mechanism already uses (`instanceAdoptionPair` already ships one
 *   registered pair; this one is missing), or the mechanism itself is never
 *   scheduled/invoked automatically for anything (`biffo doctor` is real and
 *   correct but nothing calls it on a cadence -- #1413's "third audit nobody
 *   runs" shape). Either way the mechanism runs (or could run) and sees
 *   nothing wrong only because it never actually looks here.
 * - `unverified` -- channel `"none"`: no mechanism exists for this artifact
 *   at all.
 *
 * Collapsing `unregistered` into `unverified` would erase a real distinction:
 * #1570's instance 7 ("the artifact travelled, and the thing that switches it
 * on did not") is a cheaper fix -- add a pair to an existing registry -- than
 * "no channel exists" -- build one, or make an architectural call first.
 */
export type EntryStatus = 'detected' | 'unregistered' | 'unverified'

export interface DistributionEntry {
  id: string
  artifact: string
  channel: ChannelId
  targets: string[]
  status: EntryStatus
  evidence: string[]
  notes?: string
  gapReason?: string
}

export interface DistributionInventory {
  version: number
  note: string
  channels: Record<string, ChannelDefinition>
  entries: DistributionEntry[]
}

/** Repo-relative path of the inventory, matching `core-manifest.json` and
 * `shared-files.json`'s own placement at the repo root. */
export const INVENTORY_FILENAME = 'distribution-inventory.json'

export function loadDistributionInventory(root: string): DistributionInventory {
  const path = join(root, INVENTORY_FILENAME)
  if (!existsSync(path)) {
    throw new Error(
      `${INVENTORY_FILENAME} not found at ${root} -- expected it beside core-manifest.json`,
    )
  }
  return JSON.parse(readFileSync(path, 'utf8')) as DistributionInventory
}

export interface SchemaViolation {
  entryId: string
  rule: string
  detail: string
}

/**
 * Every entry must be well-formed and internally consistent -- the same
 * enumeration discipline `guard-authority-inventory.ts` uses for #1362's
 * guard registry: a malformed or half-classified row is exactly how a real
 * gap goes on hiding in a document nobody validates.
 *
 * - `channel` must name a channel this inventory actually declares.
 * - `status: "detected"` requires the channel to carry a real
 *   `detectorCommand`/`detectorImplementation` and NOT be `"none"` -- a
 *   "detected" row pointing at no detector would be the exact false-green
 *   shape this file exists to prevent.
 * - `status: "unregistered"` requires the channel to carry a real
 *   `detectorCommand` (the mechanism exists) AND a stated `gapReason`
 *   (explaining what specifically hasn't been added to it).
 * - `status: "unverified"` requires channel `"none"` (no mechanism at all)
 *   AND a stated `gapReason` -- an unverified row with no explanation is a
 *   silence, not a finding.
 * - `evidence` must be non-empty: every row traces to a real issue or a real
 *   file, never an invented example.
 */
export function validateInventory(inventory: DistributionInventory): SchemaViolation[] {
  const violations: SchemaViolation[] = []
  const seenIds = new Set<string>()

  for (const entry of inventory.entries) {
    if (seenIds.has(entry.id)) {
      violations.push({
        entryId: entry.id,
        rule: 'duplicate-id',
        detail: 'id reused by another entry',
      })
    }
    seenIds.add(entry.id)

    const channel = inventory.channels[entry.channel]
    if (!channel) {
      violations.push({
        entryId: entry.id,
        rule: 'unknown-channel',
        detail: `channel "${entry.channel}" is not declared in inventory.channels`,
      })
      continue
    }

    if (entry.status === 'detected' && (!channel.detectorCommand || entry.channel === 'none')) {
      violations.push({
        entryId: entry.id,
        rule: 'detected-with-no-detector',
        detail: `status "detected" but channel "${entry.channel}" declares no detectorCommand`,
      })
    }

    if (entry.status === 'unregistered' && !channel.detectorCommand) {
      violations.push({
        entryId: entry.id,
        rule: 'unregistered-with-no-mechanism',
        detail:
          `status "unregistered" claims a mechanism exists to register with, but channel ` +
          `"${entry.channel}" declares no detectorCommand -- this should be "unverified" instead`,
      })
    }

    if (entry.status === 'unverified' && entry.channel !== 'none') {
      violations.push({
        entryId: entry.id,
        rule: 'unverified-on-live-channel',
        detail:
          `status "unverified" but channel "${entry.channel}" has a real detector -- this is ` +
          `"unregistered" (mechanism exists, artifact not added to it), not "unverified" (no ` +
          'mechanism at all)',
      })
    }

    if ((entry.status === 'unregistered' || entry.status === 'unverified') && !entry.gapReason) {
      violations.push({
        entryId: entry.id,
        rule: 'gap-with-no-reason',
        detail: `status "${entry.status}" requires a gapReason explaining what is missing and why`,
      })
    }

    if (entry.evidence.length === 0) {
      violations.push({
        entryId: entry.id,
        rule: 'no-evidence',
        detail: 'evidence must name at least one issue or file',
      })
    }

    if (entry.targets.length === 0) {
      violations.push({
        entryId: entry.id,
        rule: 'no-targets',
        detail: 'targets must name at least one destination',
      })
    }
  }

  return violations
}

/**
 * Does `workflowRelPath` (repo-relative) actually invoke `command`?
 *
 * A plain substring check on the workflow's raw YAML text, deliberately not a
 * YAML parse: `run:` blocks are shell, and the command strings this registry
 * cares about (`sh scripts/biffo.sh check instance-adoption`, `bash
 * scripts/shared-sync.sh --check`) appear verbatim inside them. This mirrors
 * the same "read the real invocation, not a model of it" discipline
 * `terraform-input-guard.ts`'s `findWorkflowFiles` callers already use
 * elsewhere in this package.
 */
export function workflowInvokesCommand(
  root: string,
  workflowRelPath: string,
  command: string,
): boolean {
  const path = join(root, workflowRelPath)
  if (!existsSync(path)) return false
  const text = readFileSync(path, 'utf8')
  // `detectorCommand` names the whole invocation including its flags
  // (`--instance-dir <real-instance-checkout>`), but the real call site
  // supplies concrete flag values, often after a `\`-continued line break
  // (see instance-adoption-report.yml). Match only the fixed program +
  // subcommand prefix, up to the first flag -- enough to prove the command
  // is genuinely invoked without depending on how its arguments are laid out.
  const fixedPrefix = (command.split(/\s+--/)[0] ?? command).trim()
  return text.includes(fixedPrefix)
}

/**
 * Does THIS repo's own `.github/workflows/deploy-infra.yml` set a given
 * `TF_VAR_<name>` environment variable?
 *
 * Built for #1807: `cdn-error-status-restore-lambda-tf-var`'s `gapReason`
 * asserted "this repo's OWN deploy-infra.yml never sets the var either" --
 * already false when the entry shipped (wired via #1576, two weeks earlier)
 * -- and nothing in this file's own sweep reads `gapReason` prose against
 * real repository state for anything outside the `selfCheckable`/
 * workflow-wiring checks. This is deliberately narrow rather than a general
 * prose-claim parser: it checks the one class of claim a `gapReason` can
 * make that is cheaply, mechanically falsifiable from this checkout alone --
 * "this repo's own workflow does/doesn't set env var X" -- the same
 * substring-on-raw-YAML discipline `workflowInvokesCommand` above already
 * uses, not a YAML parse.
 */
export function deployInfraSetsTfVar(root: string, varName: string): boolean {
  const path = join(root, '.github/workflows/deploy-infra.yml')
  if (!existsSync(path)) return false
  const text = readFileSync(path, 'utf8')
  return text.includes(`TF_VAR_${varName}:`)
}

/** Extract the workflow path named in a channel's `wiredIn` prose, e.g.
 * "`.github/workflows/shared-sync-report.yml`, scheduled (...)" -> the path.
 * Returns null when `wiredIn` names no workflow file (self-checkable
 * channels, or the `none` channel, both legitimately have none). */
export function wiredWorkflowPath(wiredIn: string | null): string | null {
  if (!wiredIn) return null
  const match = wiredIn.match(/\.github\/workflows\/[\w.-]+\.yml/)
  return match ? match[0] : null
}
