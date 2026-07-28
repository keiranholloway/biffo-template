/**
 * Render the daily practices dashboard from a metrics snapshot.
 *
 * ## Why this exists
 *
 * "If you cannot measure it, you cannot manage it." The collector produces the
 * numbers; this turns them into a page that can be looked at in thirty seconds
 * each morning and answers one question first: **are we building the product or
 * maintaining the machine?**
 *
 * ## The three-column rule
 *
 * Every metric is shown as 24h / 7d / 90d, and that is not decoration. This
 * estate merges ~5 PRs a day, so a 24-hour p90 is computed from a handful of
 * observations and is noise. The daily column carries **counts and events**;
 * rates and percentiles are read from the 7-day roll; the 90-day baseline is
 * the reference line an experiment has to move. A dashboard full of numbers
 * that jump randomly trains its reader to ignore it.
 *
 * Usage:
 *   node scripts/practices-dashboard.mjs --out docs/practices/dashboard.html
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { daysSince, readSessions, summariseSessions } from './practices-session.mjs'

/** SRE practice caps toil at 50%. Above that, maintenance is eating delivery. */
export const TOIL_BUDGET = 50

/** Below this, product delivery is a rounding error on total activity. */
export const PRODUCT_FEATURE_FLOOR = 20

/**
 * Grade a value against a budget, for the severity stripe on a tile.
 *
 * `null` grades as `unknown` and is styled distinctly — never as "good". A
 * dashboard that renders missing data in the same colour as a healthy reading
 * is the fail-open shape the whole programme exists to eliminate.
 *
 * @param {number | null} value
 * @param {{ warn: number, crit: number, higherIsBetter?: boolean }} thresholds
 */
export function grade(value, thresholds) {
  if (value === null || value === undefined) return 'unknown'
  const { warn, crit, higherIsBetter = false } = thresholds
  if (higherIsBetter) {
    if (value < crit) return 'critical'
    if (value < warn) return 'warning'
    return 'good'
  }
  if (value > crit) return 'critical'
  if (value > warn) return 'warning'
  return 'good'
}

/** Format a number for display, making "unmeasured" visibly different from zero. */
export function fmt(value, suffix = '') {
  if (value === null || value === undefined) return '—'
  return `${value}${suffix}`
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/**
 * Pick the snapshot to render — the most recent file by name.
 *
 * @param {string} dir
 */
export function latestSnapshotFile(dir) {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
  if (files.length === 0) throw new Error(`no snapshots in ${dir}`)
  return join(dir, files[files.length - 1])
}

const CSS = `
:root{
  --ink:#10141a; --ink-2:#39434f; --ink-3:#6b7684;
  --bg:#f7f8fa; --surface:#ffffff; --line:#e2e6ec;
  --accent:#a86b22;
  --good:#2f7d55; --warn:#946d0d; --crit:#a83f2c; --unknown:#8b95a3;
  --good-bg:#e8f3ec; --warn-bg:#faf1dc; --crit-bg:#fbeae6; --unknown-bg:#eef0f3;
}
@media (prefers-color-scheme: dark){
  :root{
    --ink:#e6eaf0; --ink-2:#a5b1c0; --ink-3:#76828f;
    --bg:#0e1218; --surface:#161c24; --line:#252d38;
    --accent:#d9973f;
    --good:#5cb98a; --warn:#d4ae4a; --crit:#e07a63; --unknown:#7b8794;
    --good-bg:#152a20; --warn-bg:#2c2515; --crit-bg:#2e1a17; --unknown-bg:#1c222b;
  }
}
:root[data-theme="dark"]{
  --ink:#e6eaf0; --ink-2:#a5b1c0; --ink-3:#76828f;
  --bg:#0e1218; --surface:#161c24; --line:#252d38;
  --accent:#d9973f;
  --good:#5cb98a; --warn:#d4ae4a; --crit:#e07a63; --unknown:#7b8794;
  --good-bg:#152a20; --warn-bg:#2c2515; --crit-bg:#2e1a17; --unknown-bg:#1c222b;
}
:root[data-theme="light"]{
  --ink:#10141a; --ink-2:#39434f; --ink-3:#6b7684;
  --bg:#f7f8fa; --surface:#ffffff; --line:#e2e6ec;
  --accent:#a86b22;
  --good:#2f7d55; --warn:#946d0d; --crit:#a83f2c; --unknown:#8b95a3;
  --good-bg:#e8f3ec; --warn-bg:#faf1dc; --crit-bg:#fbeae6; --unknown-bg:#eef0f3;
}

*{box-sizing:border-box}
body{
  margin:0; background:var(--bg); color:var(--ink);
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-size:15px; line-height:1.5;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1180px; margin:0 auto; padding:40px 24px 72px}
.num{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-variant-numeric:tabular-nums}

.masthead{display:flex; flex-wrap:wrap; gap:24px; align-items:flex-end; justify-content:space-between; border-bottom:2px solid var(--ink); padding-bottom:20px}
.masthead h1{margin:0; font-size:26px; font-weight:650; letter-spacing:-0.02em; text-wrap:balance}
.eyebrow{font-size:11px; text-transform:uppercase; letter-spacing:0.12em; color:var(--ink-3); margin:0 0 6px}
.stamp{font-size:13px; color:var(--ink-3); text-align:right}

.headline{margin:28px 0 0; padding:26px 28px; background:var(--surface); border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:3px}
.headline .q{font-size:13px; color:var(--ink-2); margin:0 0 10px}
.headline .v{font-size:52px; font-weight:680; letter-spacing:-0.03em; line-height:1}
.headline .sub{font-size:13px; color:var(--ink-3); margin-top:10px}

.grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(232px,1fr)); gap:14px; margin-top:22px}
.tile{background:var(--surface); border:1px solid var(--line); border-radius:3px; padding:16px 18px; position:relative; overflow:hidden}
.tile::before{content:""; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--stripe,var(--line))}
.tile.good{--stripe:var(--good)} .tile.warning{--stripe:var(--warn)}
.tile.critical{--stripe:var(--crit)} .tile.unknown{--stripe:var(--unknown)}
.tile .label{font-size:11px; text-transform:uppercase; letter-spacing:0.1em; color:var(--ink-3)}
.tile .value{font-size:30px; font-weight:640; letter-spacing:-0.02em; margin-top:6px}
.tile .note{font-size:12px; color:var(--ink-3); margin-top:4px}
.pill{display:inline-block; font-size:11px; padding:2px 7px; border-radius:2px; font-weight:600; letter-spacing:0.02em}
.pill.good{background:var(--good-bg); color:var(--good)}
.pill.warning{background:var(--warn-bg); color:var(--warn)}
.pill.critical{background:var(--crit-bg); color:var(--crit)}
.pill.unknown{background:var(--unknown-bg); color:var(--unknown)}

h2{font-size:13px; text-transform:uppercase; letter-spacing:0.1em; color:var(--ink-3); margin:38px 0 12px; font-weight:600}

.mix{display:flex; height:30px; border-radius:2px; overflow:hidden; border:1px solid var(--line)}
.mix span{display:block}
.legend{display:flex; flex-wrap:wrap; gap:16px; margin-top:10px; font-size:12px; color:var(--ink-2)}
.legend i{display:inline-block; width:9px; height:9px; border-radius:1px; margin-right:6px}

.scroll{overflow-x:auto; border:1px solid var(--line); border-radius:3px; background:var(--surface)}
table{border-collapse:collapse; width:100%; font-size:13px; min-width:860px}
th,td{padding:9px 12px; text-align:right; border-bottom:1px solid var(--line); white-space:nowrap}
th{font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:var(--ink-3); font-weight:600; position:sticky; top:0; background:var(--surface)}
th:first-child,td:first-child{text-align:left}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--bg)}
td.hot{color:var(--crit); font-weight:600}
td.mid{color:var(--warn)}
.side{font-size:10px; text-transform:uppercase; letter-spacing:0.08em; color:var(--ink-3); margin-left:6px}

.stale{margin-top:4px; padding:8px 10px; border-left:3px solid var(--warn); background:var(--warn-bg); color:var(--ink-2); font-size:12px}
.unvalidated{padding:16px 18px; border:1px dashed var(--warn); border-radius:3px; background:var(--warn-bg); color:var(--ink-2); font-size:13px}
.unvalidated code{font-family:ui-monospace,monospace; font-size:12px}
.sessions{display:flex; flex-direction:column; gap:6px; padding:16px 18px; background:var(--surface); border:1px solid var(--line); border-radius:3px; font-size:14px}
.sessions .k{display:inline-block; min-width:110px; font-size:11px; text-transform:uppercase; letter-spacing:0.09em; color:var(--ink-3)}
.notes{margin-top:34px; padding:18px 20px; border:1px dashed var(--line); border-radius:3px; font-size:13px; color:var(--ink-2)}
.notes h3{margin:0 0 8px; font-size:12px; text-transform:uppercase; letter-spacing:0.1em; color:var(--ink-3)}
.notes ul{margin:0; padding-left:18px} .notes li{margin:5px 0}
.notes code{font-family:ui-monospace,monospace; font-size:12px; background:var(--unknown-bg); padding:1px 4px; border-radius:2px}
`


/**
 * Compare recorded wall-clock against the merge-derived estimate.
 *
 * Every other figure on this page is inferred from commit types and repo names.
 * That inference is free and it might be wrong. This panel is the only thing
 * that can *falsify* it — and when no sessions have been recorded it says so
 * plainly rather than leaving the headline looking corroborated.
 *
 * @param {{sessions: number, hours: number, delivery: number|null, platform: number|null, toil: number|null}|null} s
 * @param {number|null} mergeToilRatio
 */
export function renderSessions(s, mergeToilRatio) {
  if (!s || !s.sessions) {
    return `<div class="unvalidated">
      <strong>No sessions recorded.</strong> Every figure above is inferred from merge
      metadata — commit types and repo names — and nothing has tested that inference
      against a real day's wall-clock. Record one with
      <code>node scripts/practices-session.mjs --minutes N --delivery N --platform N --toil N</code> after each task — entries are additive across parallel sessions.
    </div>`
  }
  const age = daysSince(s.lastDate)
  const stale = age !== null && age >= 7
  const gap =
    mergeToilRatio === null || s.toil === null ? null : Math.round((s.toil - mergeToilRatio) * 10) / 10
  const verdict =
    gap === null
      ? 'not comparable yet'
      : Math.abs(gap) <= 10
        ? `proxy agrees within ${Math.abs(gap)} points`
        : `proxy is off by ${gap > 0 ? '+' : ''}${gap} points — treat the headline with suspicion`
  return `<div class="sessions">
    <div><span class="k">recorded</span> <strong class="num">${s.tasks ?? s.sessions}</strong> tasks · <strong class="num">${s.hours}h</strong></div>
    <div><span class="k">wall-clock</span> delivery <strong class="num">${fmt(s.delivery, '%')}</strong> · platform <strong class="num">${fmt(s.platform, '%')}</strong> · toil <strong class="num">${fmt(s.toil, '%')}</strong></div>
    <div><span class="k">merge proxy</span> toil <strong class="num">${fmt(mergeToilRatio, '%')}</strong> — ${esc(verdict)}</div>
    ${stale ? `<div class="stale">Last recorded <strong>${age} days ago</strong> — a calibration that stopped is not calibration; the working pattern it validated has moved on.</div>` : ''}
  </div>`
}

/**
 * Render the whole page.
 *
 * @param {any} snapshot
 */
export function renderDashboard(snapshot, sessions = null) {
  const w = (d) => snapshot.windows?.[d]
  const day = w(1)
  const base = w(90)
  /**
   * Estate figures for a window, addressed by **day count**.
   *
   * This took a number in some call sites and a window object in others, so
   * every `e(7)` silently resolved to `{}` and all four tiles rendered "—"
   * while the headline — the one call passing an object — rendered correctly.
   * A page that says "unmeasured" when the data is present is worse than one
   * that crashes, so the signature is now one thing.
   */
  const e = (days) => w(days)?.estate ?? {}

  // #768: the headline is capability built ANYWHERE, not features in the
  // proving ground. `?? productFeatureShare` keeps snapshots written before the
  // rename rendering — they are the historical series, and a page that reports
  // `unmeasured` for last week's data is worse than one that shows it.
  const capShare = (d) => e(d).capabilityShare ?? e(d).productFeatureShare
  const featureShare = capShare(7)
  const featureGrade = grade(featureShare, {
    warn: PRODUCT_FEATURE_FLOOR,
    crit: PRODUCT_FEATURE_FLOOR / 2,
    higherIsBetter: true,
  })
  const bySide = e(7).capabilityBySide ?? {}

  const tile = (label, value, note, g) => `
    <div class="tile ${g}">
      <div class="label">${esc(label)}</div>
      <div class="value num">${esc(value)}</div>
      <div class="note">${note}</div>
    </div>`

  const mixBar = (win) => {
    const toil = e(win).toilRatio
    if (toil === null || toil === undefined) {
      return `<span style="width:100%;background:var(--unknown)" title="unmeasured"></span>`
    }
    return [
      ['delivery, quality & docs', 100 - toil, 'var(--good)'],
      ['toil + rework', toil, 'var(--crit)'],
    ]
      .map(
        ([name, share, col]) =>
          `<span style="width:${Math.max(share, 0)}%;background:${col}" title="${esc(name)} ${share.toFixed(1)}%"></span>`,
      )
      .join('')
  }

  const repos = Object.entries(base?.repos ?? {})
    .filter(([, r]) => r && !r.error && r.mergedPrs > 0)
    .sort((a, b) => b[1].mergedPrs - a[1].mergedPrs)

  const cell = (v, suffix, hot, mid) => {
    const cls = v === null || v === undefined ? '' : v > hot ? 'hot' : v > mid ? 'mid' : ''
    return `<td class="num ${cls}">${fmt(v, suffix)}</td>`
  }

  const rows = repos
    .map(([slug, r]) => {
      const d = day?.repos?.[slug]
      return `<tr>
      <td><strong>${esc(slug.split('/')[1])}</strong><span class="side">${esc(r.side ?? '')}</span></td>
      <td class="num">${fmt(d?.mergedPrs ?? 0)}</td>
      <td class="num">${fmt(r.mergedPrs)}</td>
      ${cell(r.ciFailureRate, '%', 25, 15)}
      ${cell(r.contention?.repushRate, '%', 30, 15)}
      ${cell(r.contention?.racedShare, '%', 10, 3)}
      ${cell(r.contention?.greenButUnmergedHours, 'h', 50, 10)}
      ${cell(r.workMix?.toilRatio, '%', 50, 35)}
      <td class="num">${fmt(r.rework?.medianHoursToRework, 'h')}</td>
    </tr>`
    })
    .join('\n')

  return `<title>Engineering practices — daily</title>
<style>${CSS}</style>
<div class="wrap">
  <div class="masthead">
    <div>
      <p class="eyebrow">Biffo · Tabsii — engineering practices</p>
      <h1>Are we building the product, or maintaining the machine?</h1>
    </div>
    <div class="stamp num">
      collected ${esc(String(snapshot.collectedAt ?? '').slice(0, 16).replace('T', ' '))} UTC<br />
      windows ${esc((snapshot.windowDays ?? []).join(' / '))} days
    </div>
  </div>

  <div class="headline">
    <p class="q">Capability built — merges that shipped something, rolling 7 days</p>
    <div class="v num">${fmt(featureShare, '%')}</div>
    <div class="sub">
      <span class="pill ${featureGrade}">${featureGrade}</span>
      &nbsp;90-day baseline ${fmt(capShare(90), '%')} · last 24h ${fmt(capShare(1), '%')}
      ${bySide.platform ? `· Biffo ${fmt(bySide.platform.share, '%')} · Tabsii ${fmt(bySide.product.share, '%')}` : ''}
    </div>
  </div>

  <div class="grid">
    ${tile(
      'Toil ratio · 7d',
      fmt(e(7).toilRatio, '%'),
      `rework + toil · budget ${TOIL_BUDGET}% · baseline ${fmt(e(90).toilRatio, '%')}`,
      grade(e(7).toilRatio, { warn: 40, crit: TOIL_BUDGET }),
    )}
    ${tile(
      'Platform vs product · 7d',
      `${fmt(e(7).platformShare, '%')} / ${fmt(e(7).productShare, '%')}`,
      `merges in biffo-* vs tabsii-* · baseline ${fmt(e(90).platformShare, '%')} / ${fmt(e(90).productShare, '%')}`,
      grade(e(7).productShare, { warn: 40, crit: 25, higherIsBetter: true }),
    )}
    ${tile(
      'Green-but-unmerged · 7d',
      fmt(e(7).contentionHours, 'h'),
      `correct work that could not land · baseline ${fmt(e(90).contentionHours, 'h')} over 90d`,
      grade(e(7).contentionHours, { warn: 8, crit: 20 }),
    )}
    ${tile(
      'Merges · 24h',
      fmt(e(1).merges),
      `7d ${fmt(e(7).merges)} · 90d ${fmt(e(90).merges)}`,
      'unknown',
    )}
  </div>

  <h2>Work mix — 7 days, merge-weighted</h2>
  <div class="mix">${mixBar(7)}</div>
  <div class="legend">
    <span><i style="background:var(--good)"></i>delivery, quality &amp; docs</span>
    <span><i style="background:var(--crit)"></i>toil + rework (${fmt(e(7).toilRatio, '%')})</span>
  </div>

  <h2>Wall-clock vs the merge proxy — is the headline believable?</h2>
  ${renderSessions(sessions, e(90).toilRatio)}

  <h2>By repository — 90-day baseline, with last 24h merges</h2>
  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th>Repository</th><th>24h</th><th>PRs 90d</th><th>CI fail</th>
          <th>Repush</th><th>Raced</th><th>Green wait</th><th>Toil</th><th>Rework lag</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <div class="notes">
    <h3>Reading this honestly</h3>
    <ul>
      <li><strong>Merges are not time.</strong> A one-line <code>chore:</code> and a week-long <code>feat:</code> count the same. The platform/product split is a directional proxy that costs nothing to collect — not a timesheet.</li>
      <li><strong>&mdash; means unmeasured, never zero.</strong> A repo with no CI, or no local clone, shows a dash. It is excluded from every aggregate rather than contributing a flattering zero.</li>
      <li><strong>Read rates from 7d, not 24h.</strong> At ~5 merges/day a daily percentile is noise. The 24h column carries counts; rates and percentiles come from the weekly roll.</li>
      <li><strong>Rework lag: higher is better.</strong> A fix correcting code written an hour ago is a guess that shipped; one correcting last week's code is ordinary defect discovery.</li>
      <li><strong>Green wait</strong> is time a PR was green and still could not land — the up-to-date race, not runner queueing. Runner pickup is ~0.</li>
    </ul>
  </div>
</div>
`
}

function main() {
  const argv = process.argv.slice(2)
  let out = 'docs/practices/dashboard.html'
  let dir = 'docs/practices/data'
  let sessionLog = `${process.env.HOME}/.practices-sessions.jsonl`
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out = argv[++i]
    else if (argv[i] === '--data') dir = argv[++i]
    else if (argv[i] === '--sessions') sessionLog = argv[++i]
  }
  const file = latestSnapshotFile(dir)
  const snapshot = JSON.parse(readFileSync(file, 'utf8'))
  const sessions = summariseSessions(readSessions(sessionLog))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, renderDashboard(snapshot, sessions.sessions ? sessions : null))
  process.stderr.write(`rendered ${out} from ${file}\n`)
}

if (process.argv[1] && process.argv[1].endsWith('practices-dashboard.mjs')) {
  main()
}
