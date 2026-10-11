/** Presentation helpers for agent-run views. Kept out of the page module so
 *  they can be unit-tested — a Next.js page file may only export a default and
 *  the framework's reserved fields. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Portal-wide timestamp: day first, abbreviated month, 24-hour clock, in the
 *  viewer's timezone — e.g. "10 Oct 2026, 20:23:11". Independent of the browser's
 *  language so it reads the same for every admin. */
export function formatWhen(iso: string | null): string {
  if (iso == null) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const day = String(d.getDate())
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  return `${day} ${MONTHS[d.getMonth()] ?? ''} ${String(d.getFullYear())}, ${time}`
}

/** Human-readable run duration from the two timings, e.g. "1.4s" or "—". */
export function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (startedAt == null || completedAt == null) return '—'
  const start = new Date(startedAt).getTime()
  const end = new Date(completedAt).getTime()
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—'
  const ms = end - start
  if (ms < 1000) return `${String(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rem = Math.round(seconds % 60)
  return `${String(minutes)}m ${String(rem)}s`
}

export function formatCost(cost: number | null): string {
  if (cost == null) return '—'
  return `$${cost.toFixed(4)}`
}

/**
 * Calculate and format the mean cost per priced run.
 * Mean is computed ONLY over priced runs (runs with cost_usd != null),
 * not over all runs. This matters: if 10 runs cost $1 total but 5 are
 * unpriced, the mean is $0.20 per priced run, not $0.10 per run overall.
 * Using all runs would make cheaper models appear cheaper than they are.
 *
 * @param totalCost - total cost across all priced runs (may be null)
 * @param pricedRunCount - number of runs with a cost (not null); computed by caller as (total runs - unpriced_runs)
 * @returns formatted mean cost or '—' if no priced runs
 */
export function formatMeanCost(totalCost: number | null, pricedRunCount: number): string {
  if (totalCost == null || pricedRunCount === 0) return '—'
  const mean = totalCost / pricedRunCount
  return `$${mean.toFixed(4)}`
}
