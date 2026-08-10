#!/usr/bin/env node
// biffo-scale-guard -- fails a consuming repo's CI when it declares a
// font-size, line-height or spacing value outside its configured type scale.
//
// ## Where this came from, and why it moved
//
// Built and proved first in `@tabsii-com/ui` as `tabsii-scale-guard`
// (tabsii-platform#377 Phase 2) against a real, shipped Material-3 scale. That
// version hardcoded its own package's `dist/tokens.css` as the thing being
// checked against -- correct for a repo with exactly one scale, wrong for a
// mechanism meant to sit under every Biffo instance. tabsii-platform#377's own
// text is explicit that the recurrence this exists to close -- "a new sibling
// is born with no scale and no guard" -- can only be fixed upstream, in
// biffo-template, because that is the only place a change reaches every future
// sibling rather than one already-built Tabsii app.
//
// So the MECHANISM relocated here, generalised to take its token source as an
// argument (`--tokens`) instead of assuming it. The VALUES did not move, and
// must not: `@tabsii-com/ui`'s Material-3 scale is Tabsii's, and shipping it
// into biffo-template would be the ownership boundary in reverse -- every
// other Biffo instance would inherit Tabsii's design opinions along with the
// mechanism meant to be instance-agnostic. `@biffo/design-tokens` (this
// package) currently ships colour/radius/shadow tokens only and no type
// scale at all -- seeding one is a design decision for whoever builds Biffo's
// own visual system, not something this guard's relocation should smuggle in.
//
// **There is now exactly one implementation.** `@tabsii-com/ui`'s copy is the
// one to either delete in favour of consuming this package, or reduce to a
// thin wrapper -- tracked as a separate PR in that repo (it is a different
// repo with its own release cycle; this one cannot make that change). Until
// that PR lands, two copies exist in the estate for one release cycle, same
// as any upstream-then-distribute change; the point is that nobody should
// extend tabsii-ui's copy independently in the meantime, and the follow-up
// PR is what prevents a second, silent fork the way `_extract_detail` became
// one (tabsii-platform#1107/#1108).
//
// ## What happens with no type scale configured yet (the design decision)
//
// A brand-new Biffo sibling has `@biffo/design-tokens` as a dependency, but
// that package declares no `--text-*`/`--space-*` tokens today -- so a fresh
// scaffold's token source parses to three EMPTY allowed-value sets. Two
// tempting answers were rejected:
//
//   - Treating this as "cannot tell" (like a missing tokens file) would fail
//     every new sibling's CI from day one, on a check that never observed
//     anything real. A guard that is red on day-one residue trains people to
//     stop reading it (this is the same argument `scripts/protection-audit.sh`
//     makes about ratchets generally).
//   - Silently skipping the check when the scale is empty would be fail-open
//     -- this estate's dominant defect class -- and would make the guard inert
//     exactly when a founder starts hardcoding the sizes it exists to catch.
//
// Neither is needed. `findViolations` (scale-guard-lib.mjs) already does the
// right thing with an empty allowed set: nothing is exempted, so any hardcoded
// font-size/line-height/gap is flagged, and a fresh scaffold's real source
// (checked at relocation time) declares none, so a freshly-baselined sibling
// starts at 0 and passes for real, not by construction. The guard therefore
// needs no third "not configured" exit code and no special CI-side handling:
// it runs the SAME ratchet either way, and the moment code with a hardcoded
// size lands, it fails -- correctly, because with no scale adopted yet
// "nothing hardcoded" is the only rule there is to enforce. What changes is
// only the MESSAGE: every run -- pass or fail -- states plainly how many
// scale tokens it found for each category, so "0/0/0, this guard is
// currently enforcing 'nothing hardcoded' rather than 'on an established
// scale'" is never left implicit. See isScaleConfigured() in
// scale-guard-lib.mjs.
//
// ## The rest of the design (unchanged from the relocated version)
//
//   - Reads the token source passed via `--tokens` (default: this package's
//     own tokens.css) so the checker cannot drift from the scale it is
//     checking against.
//   - Fails loudly, never silently, when it genuinely cannot do its job: no
//     files found to scan, no tokens file to read, no baseline recorded. Each
//     of those is a distinct exit-2 "cannot tell", following the convention
//     `scripts/claim.sh`/`wait-for-checks.sh` already use estate-wide --
//     never a pass. This is different from "scale not configured yet" above:
//     those are environment/setup defects, this is an expected, valid state.
//   - Ratchets rather than blocks on day-one residue: a repo's current
//     violation count is recorded in a committed baseline file, the guard
//     fails only when that count *rises*, and a fall is reported (not
//     silently banked) with an instruction to lower the baseline.
//
// Exit codes: 0 pass, 1 fail (violations rose above baseline), 2 cannot tell.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectScannableFiles,
  extractDeclarations,
  parseAllowedScale,
  isScaleConfigured,
  findViolations,
  compareToBaseline,
} from './scale-guard-lib.mjs'

function parseArgs(argv) {
  const args = { dir: process.cwd(), tokens: null, baseline: null, init: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dir') args.dir = resolve(argv[++i])
    else if (arg === '--tokens') args.tokens = resolve(argv[++i])
    else if (arg === '--baseline') args.baseline = resolve(argv[++i])
    else if (arg === '--init') args.init = true
    else if (arg === '--help' || arg === '-h') args.help = true
  }
  if (!args.baseline) args.baseline = join(args.dir, 'scale-guard-baseline.json')
  if (!args.tokens) {
    // Default: this package's own tokens.css, sitting one level up from bin/.
    // Any instance pointing --tokens elsewhere is exactly the "guard reads
    // whatever token source an instance configures" mechanism/values split --
    // this default is just the common case (a sibling that depends on
    // @biffo/design-tokens and never overrides it).
    const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    args.tokens = join(pkgRoot, 'tokens.css')
  }
  return args
}

function readDirEntries(dir) {
  return readdirSync(dir).map((name) => {
    const full = join(dir, name)
    return { name, isDirectory: statSync(full).isDirectory() }
  })
}

function loadTokensCss(tokensPath) {
  if (!existsSync(tokensPath)) {
    console.error(
      `biffo-scale-guard: cannot tell -- no tokens file at ${tokensPath}. Pass --tokens ` +
        `<path> to point at the CSS file declaring your --text-*/--space-* scale, or check ` +
        `that @biffo/design-tokens (or whatever ships this bin) installed correctly.`,
    )
    process.exit(2)
  }
  return readFileSync(tokensPath, 'utf8')
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    console.log(
      [
        'biffo-scale-guard [--dir <path>] [--tokens <path>] [--baseline <path>] [--init]',
        '',
        '  --dir       Repo root to scan for .css/.tsx/.jsx files (default: cwd)',
        '  --tokens    Path to the tokens.css declaring the --text-*/--space-* scale',
        "              (default: this package's own tokens.css)",
        '  --baseline  Path to the baseline JSON file (default: <dir>/scale-guard-baseline.json)',
        '  --init      Write the baseline file from the current violation count and exit',
      ].join('\n'),
    )
    process.exit(0)
  }

  const tokensCssText = loadTokensCss(args.tokens)
  const allowedScale = parseAllowedScale(tokensCssText)
  const configured = isScaleConfigured(allowedScale)

  // Printed on EVERY run, pass or fail -- the observability half of the
  // "no token source configured" design decision above. A reader must never
  // have to infer this from a bare PASS.
  console.log(
    `biffo-scale-guard: scale source ${args.tokens} -- ${allowedScale.fontSize.size} ` +
      `fontSize / ${allowedScale.lineHeight.size} lineHeight / ${allowedScale.spacing.size} ` +
      `spacing token(s).` +
      (configured
        ? ''
        : ' No scale adopted yet in any category -- this guard is currently enforcing ' +
          '"nothing hardcoded" rather than "on an established scale". That is expected for ' +
          'a freshly-scaffolded sibling; it stops being the whole story the moment a scale ' +
          'is added to the token source above.'),
  )

  if (!existsSync(args.dir)) {
    console.error(`biffo-scale-guard: cannot tell -- scan directory does not exist: ${args.dir}`)
    process.exit(2)
  }

  const files = collectScannableFiles(args.dir, { readDirEntries })

  if (files.length === 0) {
    console.error(
      `biffo-scale-guard: cannot tell -- found 0 .css/.tsx/.jsx files under ${args.dir} ` +
        `(node_modules, dist, build, .next, out, coverage, .turbo, .worktrees and .vercel ` +
        `are skipped). Either this repo has no scannable frontend source at that path, or ` +
        `--dir points at the wrong place -- either way, a guard that "passes" here would be ` +
        `passing because it never ran.`,
    )
    process.exit(2)
  }

  const declarations = files.flatMap((file) =>
    extractDeclarations(file, readFileSync(file, 'utf8')),
  )
  const violations = findViolations(declarations, allowedScale)

  if (args.init) {
    const baseline = {
      count: violations.length,
      recordedAt: new Date().toISOString(),
      note:
        'Baseline for the biffo-scale-guard ratchet (tabsii-platform#377 Phase 2 systemic ' +
        'half). Lower this only when real violations are fixed -- never raise it to silence ' +
        'a new one.',
    }
    writeFileSync(args.baseline, JSON.stringify(baseline, null, 2) + '\n')
    console.log(
      `biffo-scale-guard: wrote ${args.baseline} with count=${violations.length}. Commit this file.`,
    )
    process.exit(0)
  }

  if (!existsSync(args.baseline)) {
    console.error(
      `biffo-scale-guard: cannot tell -- no baseline file at ${args.baseline}. Current scan ` +
        `found ${violations.length} violation(s) across ${files.length} file(s). Run with ` +
        `--init to record that count and commit the baseline file, then re-run without --init.`,
    )
    process.exit(2)
  }

  let baseline
  try {
    baseline = JSON.parse(readFileSync(args.baseline, 'utf8'))
  } catch (err) {
    console.error(
      `biffo-scale-guard: cannot tell -- ${args.baseline} is not valid JSON: ${err.message}`,
    )
    process.exit(2)
  }

  if (typeof baseline.count !== 'number') {
    console.error(
      `biffo-scale-guard: cannot tell -- ${args.baseline} has no numeric "count" field.`,
    )
    process.exit(2)
  }

  const result = compareToBaseline(violations.length, baseline.count)

  if (result.verdict === 'fail') {
    console.error(
      `biffo-scale-guard: FAIL -- ${result.currentCount} off-scale declaration(s), ` +
        `above the baseline of ${result.baselineCount}:\n`,
    )
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.source}  (category: ${v.category})`)
    }
    console.error(
      configured
        ? '\nEither bring these back onto the configured scale, or -- if they are genuinely ' +
            'new, deliberate departures -- that is a design conversation, not something to ' +
            'fix by raising the baseline.'
        : '\nNo scale is adopted yet for at least one of these categories (see the scale ' +
            'source line above), so each is flagged as hardcoded-with-nothing-to-check-it-' +
            'against rather than off-an-established-scale. Either add these values as ' +
            'tokens in the token source and reference them, or -- if the count is accepted ' +
            'debt -- raise the baseline deliberately, in the open, rather than silently.',
    )
    process.exit(1)
  }

  if (result.verdict === 'improved') {
    console.log(
      `biffo-scale-guard: PASS -- ${result.currentCount} off-scale declaration(s), down from ` +
        `a baseline of ${result.baselineCount}. Lower the baseline: set "count" to ` +
        `${result.currentCount} in ${args.baseline} and commit it.`,
    )
    process.exit(0)
  }

  console.log(
    `biffo-scale-guard: PASS -- ${result.currentCount} off-scale declaration(s), at baseline.`,
  )
  process.exit(0)
}

main()
