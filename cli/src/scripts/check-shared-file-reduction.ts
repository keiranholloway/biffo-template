/**
 * Sync-time entrypoint for the shared-file reduction guard (#1577): refuse a
 * `shared-files.json` overwrite that would DELETE tests from the satellite it
 * lands in.
 *
 * Invoked by `scripts/shared-sync.sh` at the moment of the `cp`, once per
 * repo, with the pairs it is about to write. It is deliberately NOT a per-PR
 * CI guard (see `check.test.ts`'s `auditOnly` list): both sides of the
 * comparison — the canonical copy here and the satellite's current copy —
 * only exist together inside a sync run, which has already fetched and
 * checked out the satellite. Nothing in this repo's own tree can answer the
 * question.
 *
 * Exit contract, matching the estate's three-valued convention
 * (`wait-for-checks.sh`, `branch-health.sh`): **0** no reduction, **1** a
 * reduction that is not declared intended, **2** cannot tell. Exit 2 is never
 * a pass — an unreadable pair must stop a sync, not wave it through, because
 * the operation it is gating is irreversible content deletion.
 *
 * See `../lib/shared-file-reduction-guard.ts` for what "reduce" means, why
 * this is #1577's level 2 rather than level 1, and — stated explicitly there
 * — the substantial list of things it does NOT catch.
 */
import { readFileSync } from 'node:fs'
import {
  checkSharedFileReduction,
  formatReductionReport,
  type AcceptedReductions,
  type SyncPair,
} from '../lib/shared-file-reduction-guard.js'

export interface ReductionCheckArgs {
  /** TSV of `target<TAB>existingPath<TAB>incomingPath` lines, or `-` for
   * stdin. The batch form: one process per repo rather than one per file. */
  pairs?: string
  /** Single-pair form, so a human reproducing an incident can run this in one
   * line without building a TSV. */
  target?: string
  existing?: string
  incoming?: string
  /** `shared-files.json`, read for `acceptedReductions`. Optional: absent
   * means no declared losses, which fails MORE, never less. */
  manifest?: string
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** Parse the TSV into pairs, reading both sides off disk. A malformed line or
 * an unreadable file is a hard error, not a skipped row: silently dropping an
 * input is how a check reports the remainder as the whole (#1145). */
function pairsFromTsv(tsv: string): SyncPair[] {
  const pairs: SyncPair[] = []
  for (const raw of tsv.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const fields = line.split('\t')
    if (fields.length !== 3) {
      throw new Error(`malformed pair line (want target<TAB>existing<TAB>incoming): ${line}`)
    }
    const [target, existingPath, incomingPath] = fields as [string, string, string]
    pairs.push({
      target,
      existing: readFileSync(existingPath, 'utf8'),
      incoming: readFileSync(incomingPath, 'utf8'),
    })
  }
  return pairs
}

function loadAccepted(manifestPath: string | undefined): AcceptedReductions {
  if (!manifestPath) return {}
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    acceptedReductions?: AcceptedReductions
  }
  return parsed.acceptedReductions ?? {}
}

export async function runSharedFileReductionCheck(args: ReductionCheckArgs): Promise<void> {
  let pairs: SyncPair[]
  let accepted: AcceptedReductions
  try {
    if (args.pairs) {
      pairs = pairsFromTsv(args.pairs === '-' ? readStdin() : readFileSync(args.pairs, 'utf8'))
    } else if (args.target && args.existing && args.incoming) {
      pairs = [
        {
          target: args.target,
          existing: readFileSync(args.existing, 'utf8'),
          incoming: readFileSync(args.incoming, 'utf8'),
        },
      ]
    } else {
      console.error(
        '✗ shared-file reduction guard: give --pairs <tsv|-> or ' +
          '--target/--existing/--incoming. Cannot tell.',
      )
      process.exit(2)
    }
    accepted = loadAccepted(args.manifest)
  } catch (error) {
    // Exit 2, never 0. The thing being gated is an irreversible overwrite, so
    // "I could not read one side of the comparison" must stop the sync.
    console.error(
      `✗ shared-file reduction guard: cannot tell — ${(error as Error).message}. ` +
        'Refusing to certify an overwrite this guard could not read.',
    )
    process.exit(2)
  }

  const report = checkSharedFileReduction(pairs, accepted)
  const output = formatReductionReport(report)

  if (report.findings.length > 0) {
    console.error(output)
    console.error('')
    console.error('See cli/src/lib/shared-file-reduction-guard.ts (biffo-template#1577).')
    process.exit(1)
  }

  console.log(output)
}
