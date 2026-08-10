// Pure functions for `biffo-scale-guard` (see scale-guard.mjs for the CLI
// shell). Kept dependency-free and side-effect-free on purpose: every
// consuming repo installs this transitively via @biffo/design-tokens, so it
// adds no new packages to anyone's tree, and it is unit-testable without
// touching the filesystem or a real tokens.css.
//
// ## Where this came from
//
// Relocated from `@tabsii-com/ui`'s `bin/scale-guard.mjs` (tabsii-platform#377
// Phase 2), where it was built and proved against a real, shipped Material-3
// scale. That version resolved its own package's `dist/tokens.css` by walking
// up from itself -- correct for a repo with exactly one scale to check
// against, wrong for a template meant to sit under every Biffo instance, each
// of which may define (or not yet define) its own scale. THIS file is the
// generic relocation: every function below is unchanged in behaviour, but the
// CLI shell (scale-guard.mjs) takes the token source as a `--tokens <path>`
// argument instead of assuming it. See that file's header for the mechanism/
// values split this enforces.
//
// Design note (tabsii-platform#377 Phase 2, carried forward unchanged): this
// checker reads the target repo's *hardcoded* CSS/TSX declarations and
// compares them against the scale -- not the other way around. A guard that
// only asserts "the scale in tokens.css is well-formed" would be worthless:
// tabsii-marketplace's ~15 off-scale sizes proved consumers ignore an
// existing scale regardless. Only reading call sites catches that class.

const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.turbo',
  '.worktrees',
  '.vercel',
])

const SCANNABLE_EXTENSIONS = new Set(['.css', '.tsx', '.jsx'])

/**
 * Recursively lists files under `rootDir` matching SCANNABLE_EXTENSIONS,
 * skipping IGNORED_DIR_NAMES. Takes a `readDirFn`/`isDirFn` pair so tests can
 * supply an in-memory tree instead of touching disk.
 */
export function collectScannableFiles(rootDir, { readDirEntries, joinPath = defaultJoin } = {}) {
  const results = []
  const stack = [rootDir]

  while (stack.length > 0) {
    const dir = stack.pop()
    const entries = readDirEntries(dir)
    for (const entry of entries) {
      if (entry.isDirectory) {
        if (!IGNORED_DIR_NAMES.has(entry.name)) {
          stack.push(joinPath(dir, entry.name))
        }
        continue
      }
      const ext = extname(entry.name)
      if (SCANNABLE_EXTENSIONS.has(ext)) {
        results.push(joinPath(dir, entry.name))
      }
    }
  }
  return results.sort()
}

function extname(name) {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i)
}

function defaultJoin(a, b) {
  return `${a}/${b}`
}

/** Converts a `{value, unit}` pair to px. Returns null for an unhandled unit. */
export function toPx(value, unit) {
  if (unit === 'px') return value
  if (unit === 'rem') return value * 16 // documented assumption: 1rem == 16px root font-size
  return null
}

// The numeric group below is deliberately NOT `[0-9]*\.?[0-9]+` -- that shape
// has two quantifiers (`*` and `+`) running over the SAME character class
// with nothing but an OPTIONAL literal between them, so a run of digits with
// no unit suffix (e.g. a hand-crafted "gap:00000000...") has O(n) equally
// valid ways to split between the two, and the engine tries all of them
// before giving up when `(px|rem)` fails to follow -- polynomial blowup on
// attacker- or generator-controlled CSS, flagged by CodeQL's
// js/polynomial-redos on this exact shape (high severity, all three
// instances of it in this file, tabsii-platform#377 follow-up). The fix
// removes the ambiguity rather than papering over it: `[0-9]+(?:\.[0-9]+)?`
// greedily consumes every digit in one pass with a SINGLE quantifier, and
// the trailing `(?:\.[0-9]+)?` is only ever entered by matching a literal
// "." first -- so on a dot-free digit run it resolves to "no match" in one
// O(1) check with nothing left to backtrack into. `|\.[0-9]+` keeps
// `.5rem`-style CSS (a leading-dot decimal with no integer part) matching,
// as an alternative that starts on a DIFFERENT character (".") to the first
// branch (a digit) -- so the two branches never compete over the same
// characters either.
const NUMBER_RE_SOURCE = '(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)'

const CSS_PROPERTY_RE = new RegExp(
  `(font-size|line-height|gap|row-gap|column-gap)\\s*:\\s*(${NUMBER_RE_SOURCE})(px|rem)\\b`,
  'g',
)

const TAILWIND_ARBITRARY_RE = new RegExp(
  `\\b(text|leading|gap|row-gap|column-gap)-\\[(${NUMBER_RE_SOURCE})(px|rem)\\]`,
  'g',
)

const CATEGORY_BY_CSS_PROPERTY = {
  'font-size': 'fontSize',
  'line-height': 'lineHeight',
  gap: 'spacing',
  'row-gap': 'spacing',
  'column-gap': 'spacing',
}

const CATEGORY_BY_TAILWIND_PREFIX = {
  text: 'fontSize',
  leading: 'lineHeight',
  gap: 'spacing',
  'row-gap': 'spacing',
  'column-gap': 'spacing',
}

/**
 * Scans one file's text for hardcoded font-size/line-height/spacing
 * declarations -- plain CSS properties and Tailwind arbitrary-value classes
 * alike -- and returns one entry per match with its resolved px value.
 * Unitless and keyword values (`line-height: 1.5`, `gap: normal`) are not
 * comparable to a px scale and are deliberately not matched.
 */
export function extractDeclarations(filePath, fileText) {
  const declarations = []
  const lines = fileText.split('\n')

  lines.forEach((line, idx) => {
    const lineNumber = idx + 1

    CSS_PROPERTY_RE.lastIndex = 0
    let match
    while ((match = CSS_PROPERTY_RE.exec(line))) {
      const [, property, rawValue, unit] = match
      const px = toPx(parseFloat(rawValue), unit)
      declarations.push({
        file: filePath,
        line: lineNumber,
        category: CATEGORY_BY_CSS_PROPERTY[property],
        source: `${property}: ${rawValue}${unit}`,
        px,
      })
    }

    TAILWIND_ARBITRARY_RE.lastIndex = 0
    while ((match = TAILWIND_ARBITRARY_RE.exec(line))) {
      const [, prefix, rawValue, unit] = match
      const px = toPx(parseFloat(rawValue), unit)
      declarations.push({
        file: filePath,
        line: lineNumber,
        category: CATEGORY_BY_TAILWIND_PREFIX[prefix],
        source: `${prefix}-[${rawValue}${unit}]`,
        px,
      })
    }
  })

  return declarations
}

// Originally `([a-z0-9-]+?)(-line-height)?:` -- a LAZY key-name quantifier
// immediately followed by an OPTIONAL literal that starts with a character
// ("-") already inside the lazy group's own class. CodeQL flagged this too
// ("may run slow on strings starting with '--text--:' and with many
// repetitions"): a run of hyphens gives the engine many equally-valid points
// to stop growing the lazy group and try the optional suffix, all of which
// fail identically when no ":" ever follows (a malformed/attacker line).
// Fixed the same way as the numeric patterns above -- remove the ambiguity
// rather than bound it: capture the WHOLE key with a single greedy
// quantifier bounded by the mandatory ":", then peel the "-line-height"
// suffix off in plain JS below, where a `String.endsWith` is O(1) against
// the engine, not a second regex quantifier competing for the same text.
const TOKEN_LINE_RE = new RegExp(`^\\s*--(text|space)-([a-z0-9-]+):\\s*(${NUMBER_RE_SOURCE})px;`)

const LINE_HEIGHT_KEY_SUFFIX = '-line-height'

/**
 * Parses a tokens.css file into the three allowed-value sets a scanned
 * declaration is checked against, using the fixed `--text-<key>` /
 * `--text-<key>-line-height` / `--space-<key>` naming convention. This
 * convention -- not any particular set of values -- is the generic contract
 * between the guard and whatever token source an instance configures: the
 * MECHANISM (this file) is generic, and lives in biffo-template; the VALUES
 * are per-instance, and live in whatever `--tokens` points at. See
 * scale-guard.mjs's header for why nothing Tabsii- or instance-specific
 * belongs in this file.
 *
 * Reading the shipped CSS rather than re-declaring the scale here is what
 * keeps this checker from drifting from the source of truth the way the
 * consumers it checks already have.
 */
export function parseAllowedScale(tokensCssText) {
  const fontSize = new Set()
  const lineHeight = new Set()
  const spacing = new Set()

  for (const rawLine of tokensCssText.split('\n')) {
    const match = TOKEN_LINE_RE.exec(rawLine)
    if (!match) continue
    const [, kind, key, value] = match
    const px = parseFloat(value)
    if (kind === 'text') {
      if (key.endsWith(LINE_HEIGHT_KEY_SUFFIX)) lineHeight.add(px)
      else fontSize.add(px)
    } else if (kind === 'space') {
      spacing.add(px)
    }
  }

  return { fontSize, lineHeight, spacing }
}

/**
 * True when `allowedScale` declares no tokens in any of the three
 * categories -- i.e. the token source this guard was pointed at exists and
 * parses, but simply has not adopted a type scale yet. This is the "no token
 * source configured" case scale-guard.mjs's header discusses: deliberately
 * NOT the same fact as a missing/unreadable tokens file (that stays a hard,
 * blocking "cannot tell" -- see loadTokensCss in scale-guard.mjs), because a
 * brand-new Biffo sibling is expected to be in this state, and a guard that
 * cannot tell "broken" from "not adopted yet" cannot treat them differently.
 */
export function isScaleConfigured(allowedScale) {
  return allowedScale.fontSize.size + allowedScale.lineHeight.size + allowedScale.spacing.size > 0
}

const EPSILON = 0.01

function isAllowed(px, allowedSet) {
  if (px === null) return true // unhandled unit -- not this checker's job to judge
  for (const allowedPx of allowedSet) {
    if (Math.abs(allowedPx - px) < EPSILON) return true
  }
  return false
}

/**
 * Filters `declarations` down to those whose px value is outside
 * `allowedScale`. When a category's allowed set is EMPTY (no scale adopted
 * yet for that category), every declaration in that category is flagged --
 * correct, not a bug: with no scale to conform to, "declare nothing
 * hardcoded" is the only rule available, and this is exactly what turns the
 * ratchet from inert into a real guard the moment code starts appearing. See
 * isScaleConfigured() for the label this state gets in the CLI's output.
 */
export function findViolations(declarations, allowedScale) {
  return declarations.filter((d) => !isAllowed(d.px, allowedScale[d.category]))
}

/**
 * Compares a current violation count against a recorded baseline. This is
 * the ratchet: a rise fails, a fall or a hold passes, and a fall says so
 * explicitly rather than silently banking the improvement.
 */
export function compareToBaseline(currentCount, baselineCount) {
  if (currentCount > baselineCount) {
    return { verdict: 'fail', currentCount, baselineCount }
  }
  if (currentCount < baselineCount) {
    return { verdict: 'improved', currentCount, baselineCount }
  }
  return { verdict: 'pass', currentCount, baselineCount }
}
