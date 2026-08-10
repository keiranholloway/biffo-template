// Tests for scale-guard-lib.mjs. Uses vitest, matching this package's own
// test runner (see ../tokens.test.ts) -- unlike the tabsii-ui original this
// was relocated from, which reached for node:test because it had no existing
// harness to match.
import { describe, expect, it } from 'vitest'
import {
  collectScannableFiles,
  toPx,
  extractDeclarations,
  parseAllowedScale,
  isScaleConfigured,
  findViolations,
  compareToBaseline,
} from './scale-guard-lib.mjs'

// A tokens.css shaped exactly like scripts/build-tokens-css.mjs's real
// @tabsii-com/ui output (trimmed to the parts this checker reads), so
// parseAllowedScale is tested against a real artefact shape, not an invented
// one -- the generic `--text-<key>` / `--space-<key>` naming convention this
// checker relies on is the one that shape established.
const SAMPLE_TOKENS_CSS = `:root {
  --primary: #006c49;
  --radius: 0.5rem;
  --radius-sm: 0.25rem;
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-gutter: 24px;
  --space-container-max: 1280px;
  --font-heading: 'Hanken Grotesk', sans-serif;
  --font-body: 'Inter', sans-serif;
  --text-headline-sm: 20px;
  --text-headline-sm-line-height: 28px;
  --text-headline-sm-weight: 600;
  --text-body-md: 16px;
  --text-body-md-line-height: 24px;
  --text-headline-lg: 32px;
  --text-headline-lg-line-height: 40px;
  --text-headline-lg-tracking: -0.01em;
}
`

// A tokens.css with no type scale at all -- colour/radius tokens only. This
// is the shape @biffo/design-tokens/tokens.css is in TODAY (see that file),
// which is exactly the "no token source configured" case scale-guard.mjs's
// header discusses.
const NO_SCALE_TOKENS_CSS = `:root {
  --brand: #5457ee;
  --radius: 14px;
  --radius-lg: 22px;
  --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.06);
}
`

describe('parseAllowedScale', () => {
  it('reads fontSize, lineHeight and spacing from a tokens.css', () => {
    const scale = parseAllowedScale(SAMPLE_TOKENS_CSS)
    expect([...scale.fontSize].sort((a, b) => a - b)).toEqual([16, 20, 32])
    expect([...scale.lineHeight].sort((a, b) => a - b)).toEqual([24, 28, 40])
    expect([...scale.spacing].sort((a, b) => a - b)).toEqual([4, 8, 16, 24, 1280])
  })

  it('ignores -weight and -tracking lines (non-px units/values)', () => {
    const scale = parseAllowedScale(SAMPLE_TOKENS_CSS)
    // 600 (a weight) and -0.01em (a tracking) must not leak into any set.
    for (const set of [scale.fontSize, scale.lineHeight, scale.spacing]) {
      expect(set.has(600)).toBe(false)
    }
  })

  it('returns three empty sets for a tokens.css with no --text-*/--space-* tokens', () => {
    const scale = parseAllowedScale(NO_SCALE_TOKENS_CSS)
    expect(scale.fontSize.size).toBe(0)
    expect(scale.lineHeight.size).toBe(0)
    expect(scale.spacing.size).toBe(0)
  })
})

describe('isScaleConfigured', () => {
  it('is true when at least one category has a token', () => {
    expect(isScaleConfigured(parseAllowedScale(SAMPLE_TOKENS_CSS))).toBe(true)
  })

  it('is false when every category is empty -- the fresh-sibling / real design-tokens case', () => {
    expect(isScaleConfigured(parseAllowedScale(NO_SCALE_TOKENS_CSS))).toBe(false)
  })
})

describe('toPx', () => {
  it('converts rem at 16px root and passes px through unchanged', () => {
    expect(toPx(24, 'px')).toBe(24)
    expect(toPx(1.5, 'rem')).toBe(24)
    expect(toPx(0.75, 'rem')).toBe(12)
  })

  it('returns null for an unhandled unit rather than guessing', () => {
    expect(toPx(2, 'em')).toBeNull()
  })
})

describe('extractDeclarations', () => {
  it('finds hardcoded CSS font-size/line-height/gap with line numbers', () => {
    const css = [
      '.card h1 {',
      '  font-size: 34px;', // off-scale, matches marketplace's real auth-split heading
      '  line-height: 40px;',
      '}',
      '.row { gap: 0.6rem; }',
    ].join('\n')

    const decls = extractDeclarations('globals.css', css)

    expect(decls.map((d) => ({ line: d.line, category: d.category, px: d.px }))).toEqual([
      { line: 2, category: 'fontSize', px: 34 },
      { line: 3, category: 'lineHeight', px: 40 },
      { line: 5, category: 'spacing', px: 9.6 },
    ])
  })

  it('finds Tailwind arbitrary-value classes', () => {
    const tsx = `<h1 className="text-[13px] leading-[1.2rem] gap-[10px]">Title</h1>`
    const decls = extractDeclarations('page.tsx', tsx)
    expect(decls.map((d) => ({ category: d.category, px: d.px }))).toEqual([
      { category: 'fontSize', px: 13 },
      { category: 'lineHeight', px: 19.2 },
      { category: 'spacing', px: 10 },
    ])
  })

  it('does not match unitless or keyword values', () => {
    const css = '.x { line-height: 1.5; gap: normal; font-size: inherit; }'
    expect(extractDeclarations('x.css', css)).toEqual([])
  })
})

describe('findViolations', () => {
  it('flags only declarations whose category value is outside the scale', () => {
    const allowed = {
      fontSize: new Set([16, 20]),
      lineHeight: new Set([24]),
      spacing: new Set([8, 16]),
    }
    const declarations = [
      { file: 'a.css', line: 1, category: 'fontSize', source: 'font-size: 16px', px: 16 }, // on-scale
      { file: 'a.css', line: 2, category: 'fontSize', source: 'font-size: 13px', px: 13 }, // off-scale
      { file: 'a.css', line: 3, category: 'spacing', source: 'gap: 0.625rem', px: 10 }, // off-scale
      { file: 'a.css', line: 4, category: 'lineHeight', source: 'line-height: 24px', px: 24 }, // on-scale
    ]
    const violations = findViolations(declarations, allowed)
    expect(violations.map((v) => v.line)).toEqual([2, 3])
  })

  it('treats an unresolved unit (px === null) as not this checker’s call', () => {
    const allowed = { fontSize: new Set([16]), lineHeight: new Set(), spacing: new Set() }
    const declarations = [
      { file: 'a.css', line: 1, category: 'fontSize', source: 'font-size: 1em', px: null },
    ]
    expect(findViolations(declarations, allowed)).toEqual([])
  })

  it('flags EVERY declaration in a category whose allowed set is empty -- the no-scale-yet case', () => {
    // This is the core mechanic behind the "no token source configured"
    // design decision: an empty allowed set is not a free pass, it means
    // "nothing hardcoded is allowed" until a scale exists.
    const allowed = { fontSize: new Set(), lineHeight: new Set(), spacing: new Set() }
    const declarations = [
      { file: 'a.css', line: 1, category: 'fontSize', source: 'font-size: 22px', px: 22 },
    ]
    expect(findViolations(declarations, allowed)).toHaveLength(1)
  })
})

describe('compareToBaseline', () => {
  it('a rise fails', () => {
    expect(compareToBaseline(20, 15).verdict).toBe('fail')
  })

  it('a fall reports improved, not a silent pass', () => {
    expect(compareToBaseline(10, 15).verdict).toBe('improved')
  })

  it('holding steady passes', () => {
    expect(compareToBaseline(15, 15).verdict).toBe('pass')
  })
})

describe('collectScannableFiles', () => {
  it('walks nested dirs, skips ignored dirs, filters by extension', () => {
    // In-memory tree:
    // /repo/src/app/globals.css
    // /repo/src/app/page.tsx
    // /repo/src/app/page.test.ts   (wrong extension -- skipped)
    // /repo/node_modules/x/globals.css  (ignored dir -- skipped)
    const tree = {
      '/repo': [
        { name: 'src', isDirectory: true },
        { name: 'node_modules', isDirectory: true },
      ],
      '/repo/src': [{ name: 'app', isDirectory: true }],
      '/repo/src/app': [
        { name: 'globals.css', isDirectory: false },
        { name: 'page.tsx', isDirectory: false },
        { name: 'page.test.ts', isDirectory: false },
      ],
      '/repo/node_modules': [{ name: 'x', isDirectory: true }],
      '/repo/node_modules/x': [{ name: 'globals.css', isDirectory: false }],
    }
    const files = collectScannableFiles('/repo', {
      readDirEntries: (dir) => tree[dir] ?? [],
      joinPath: (a, b) => `${a}/${b}`,
    })
    expect(files).toEqual(['/repo/src/app/globals.css', '/repo/src/app/page.tsx'])
  })
})

describe('pathological input (ReDoS regression)', () => {
  // CodeQL (js/polynomial-redos, high severity) flagged all three regexes in
  // this file: the numeric group `[0-9]*\.?[0-9]+` and the key-name group
  // `([a-z0-9-]+?)(-line-height)?` each had two quantifiers competing over
  // the same character class, separated only by something optional -- a run
  // of the shared character with no terminator forces the engine through
  // O(n) equally-valid ways to split it, and it tries all of them before
  // giving up. This is not theoretical: this code is about to be scaffolded
  // into every new Biffo sibling, so a single generated or pathological CSS
  // file would hang that sibling's CI with no obvious cause.
  //
  // These tests don't assert the OLD patterns are slow (nothing here runs
  // them) -- they assert the CURRENT ones stay fast against exactly the
  // input shapes CodeQL named, with a generous-but-real budget, so a future
  // rewrite that reintroduces the ambiguous shape is caught by a failing
  // test rather than a slow CI run somewhere downstream. 200ms is roughly
  // 100-1000x the observed time (see the timing note logged by each test) --
  // tight enough to fail on a real O(n^2) regression at this input size,
  // loose enough not to flake on a slow CI runner.
  const BUDGET_MS = 200
  const N = 200_000

  it('extractDeclarations: a long unterminated digit run after "gap:" stays linear', () => {
    // The exact shape CodeQL named: "may run slow on strings starting with
    // 'gap:' and with many repetitions of '0'". No px/rem ever follows, so
    // the old pattern would exhaust every split between `[0-9]*` and
    // `[0-9]+` before failing.
    const css = `.row { gap: ${'0'.repeat(N)}`
    const start = performance.now()
    const decls = extractDeclarations('attack.css', css)
    const elapsed = performance.now() - start
    console.log(`gap: + ${N} zeros, no unit: ${elapsed.toFixed(1)}ms`)
    expect(decls).toEqual([]) // no unit suffix -- correctly not a match, not a hang
    expect(elapsed).toBeLessThan(BUDGET_MS)
  })

  it('extractDeclarations: a long unterminated digit run in a Tailwind arbitrary value stays linear', () => {
    const tsx = `<div className="text-[${'0'.repeat(N)}">`
    const start = performance.now()
    const decls = extractDeclarations('attack.tsx', tsx)
    const elapsed = performance.now() - start
    console.log(`text-[ + ${N} zeros, no closing unit/bracket: ${elapsed.toFixed(1)}ms`)
    expect(decls).toEqual([])
    expect(elapsed).toBeLessThan(BUDGET_MS)
  })

  it('parseAllowedScale: a long unterminated hyphen run in a token key stays linear', () => {
    // The exact shape CodeQL named: "may run slow on strings starting with
    // '--text--:' and with many repetitions". No terminating ": <num>px;"
    // ever appears, so the old lazy key-group + optional "-line-height"
    // suffix would try every stopping point along the hyphen run.
    const css = `--text-${'-'.repeat(N)}`
    const start = performance.now()
    const scale = parseAllowedScale(css)
    const elapsed = performance.now() - start
    console.log(`--text- + ${N} hyphens, no terminator: ${elapsed.toFixed(1)}ms`)
    expect(isScaleConfigured(scale)).toBe(false) // no match -- correctly empty, not a hang
    expect(elapsed).toBeLessThan(BUDGET_MS)
  })

  it('parseAllowedScale: a long unterminated digit run in a token value stays linear', () => {
    const css = `--text-body-md: ${'0'.repeat(N)}`
    const start = performance.now()
    const scale = parseAllowedScale(css)
    const elapsed = performance.now() - start
    console.log(`--text-body-md: + ${N} zeros, no "px;": ${elapsed.toFixed(1)}ms`)
    expect(isScaleConfigured(scale)).toBe(false)
    expect(elapsed).toBeLessThan(BUDGET_MS)
  })
})
