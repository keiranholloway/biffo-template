import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * The second signal on `guard-candidates.ts`'s discovery+classification
 * mechanism, for class issue #1363: "a gate in this estate cannot report
 * green without either covering its whole input or naming what it skipped."
 *
 * ## Why this extends guard-candidates.ts rather than building separately
 *
 * #1519 already built the machinery this class needs a home on:
 * `discoverGuardCandidates` enumerates every guard-shaped file under
 * `cli/src/lib` from two independent signals (never a hand-maintained list),
 * and `GUARD_CANDIDATE_CLASSIFICATION` forces every candidate to be
 * explicitly resolved — `isGuard: true` with a reason, or `isGuard: false`
 * with one — before `guard-candidates.test.ts` lets the build pass. A second
 * question ("does it state its denominator when it passes?") on the same
 * enumerated set is the natural extension of that mechanism, not a new one:
 * building a parallel discovery pass here would be exactly the
 * drifting-second-copy defect this estate keeps re-finding.
 *
 * ## This OBSERVES output. It does not read source. That is the whole point.
 *
 * The first version of this module answered the question **statically**: walk
 * the guard's TypeScript AST and look for a print call whose argument is a
 * denominator-shaped template with an interpolation. An independent
 * pre-merge prosecution broke it in one sitting, and the breakage was not a
 * loose pattern — it was a class:
 *
 * ```ts
 * export function assertFakeThing(items: string[]): void {
 *   if (false) {
 *     console.log(`examined ${items.length} item(s)`)   // never runs
 *   }
 *   ...
 * }
 *
 * function neverCalled(items: string[]): void {
 *   console.log(`checked ${items.length} item(s)`)      // nothing calls it
 * }
 * ```
 *
 * Both registered as compliant. A comment-only mention correctly did not, so
 * it was never a regex-over-text problem — it was a **reachability** problem,
 * and reachability is undecidable in general. Every patch to the AST walk
 * (fold statically-false conditions, build a call graph, ...) invites the
 * next bypass, and a detector satisfiable by code that never runs has exactly
 * the shape of the defect it exists to catch: a green that is a statement
 * about nothing.
 *
 * So the question is now asked the way the prosecutor asked it by hand:
 * **run the guard and read what it actually printed.** There is no dead-code
 * bypass of an observation, because an unreached `console.log` emits no
 * bytes. That is also #1363's own "question three" — did the job execute, and
 * over what input set — applied to the mechanism built to answer it.
 *
 * ## The two execution routes, and why both
 *
 * A guard is credited only if a line **actually emitted** by one of these
 * states a count (denominator vocabulary AND a bare number on the same line):
 *
 *   1. **Its CI-wired check command.** `sh scripts/biffo.sh check <name>` is
 *      literally what `ci.yml` runs — in the template that bridge execs the
 *      working tree's `cli/` through tsx, so this observes THIS branch's
 *      guards against THIS repo, not a published release. The invocations are
 *      discovered by reading the wiring files (`.github/workflows/`,
 *      `.githooks/`, `scripts/`), never listed here. A check is mapped back to
 *      the guard module(s) its `cli/src/scripts/check-<name>.ts` entrypoint
 *      imports, read from the TypeScript AST (#956).
 *
 *   2. **Its own same-basename `*.test.ts`.** One child `vitest run
 *      --reporter=verbose` over the guard test pairs, with console output
 *      attributed per file by the reporter's own `stdout | <file> > <test>`
 *      header. This is the route a new guard can satisfy inside a `cli/`-only
 *      change — `template-owned-scope.test.ts`'s `[coverage] <scanner>: N
 *      path(s) reached` (added by #1454, an instance of this very class) is
 *      the shape it exists for. Without it the only way to pass would be to
 *      add a CI step, and a gate that can only be satisfied by editing a
 *      workflow is a gate people route around.
 *
 * ## What this deliberately does NOT reach — named, not silently narrowed
 *
 *   - **Anything that is not a TypeScript guard under `cli/src/lib`.** This
 *     repo alone carries ~30 shell scripts under `scripts/` and `.githooks/`,
 *     25 GitHub Actions workflow files, and at least half a dozen Python
 *     `check*`/`assert*`/`audit*` functions under `services/`. None of them is
 *     in this denominator. The 25 TypeScript guards it does cover are a
 *     minority of the estate's real gates.
 *   - **Checks that need a merge base.** `ownership`, `release-subject` and
 *     `migration-body-change` read `GITHUB_BASE_REF` and diff against
 *     `origin/<base>`; there is no meaningful base for this harness to supply,
 *     and driving them with whatever the ambient environment happens to hold
 *     would make the verdict depend on where it ran. They are excluded
 *     mechanically (the entrypoint mentions `GITHUB_BASE_REF`), reported by
 *     name, and their guards sit in the baseline.
 *   - **Checks only ever invoked with arguments.** `shared-file-reduction` is
 *     called by `scripts/shared-sync.sh` with `--pairs`, which only exist
 *     inside a live sync round. Reported by name.
 *   - **A print in an unrelated third-party caller.** Route 2 is the guard's
 *     OWN test pair only. `template-owned-scope.test.ts` prints a real count
 *     for `terraform-input-guard.findWorkflowFiles`, and that print credits
 *     nobody here. Widening route 2 to "any test file importing the guard"
 *     would let a new non-printing guard be credited by a count another guard
 *     printed in a shared test file, which is a cheaper bypass than the one
 *     this rewrite closes.
 *   - **Attribution is per entrypoint, not per function.** A check whose
 *     `check-<name>.ts` imports two guard modules credits both. Two do today
 *     (`check-lambda-output.ts` and `check-skeleton-drift.ts` both import
 *     `terraform-input-guard.ts` for its workflow-file walk), and both of
 *     those guards are credited by their own checks anyway, so nothing is
 *     carried by it today. The residual bypass is to import a new
 *     non-printing guard into an existing check entrypoint — which leaves an
 *     unused import that `pnpm run lint` rejects.
 *   - **A HARDCODED count.** This is the one place observation is strictly
 *     weaker than the static walk it replaces, and it is a measured result,
 *     not a suspicion: `console.log('examined 25 item(s)')` — a literal, no
 *     runtime value anywhere near it — satisfies this gate, because at runtime
 *     a computed number and a typed one are the same bytes. The old AST
 *     detector required an interpolation and would have rejected it. The two
 *     detectors have mirror-image blind spots (that one accepted a dynamic
 *     print that never ran; this one accepts a static print that does), and
 *     runtime observation is the half worth keeping because #1363's question
 *     is "did the job execute, and over what input" — a guard that emits
 *     nothing answers neither, while one that emits a wrong number at least
 *     answers in public, in the CI log, where a stale count is legible. The
 *     natural next increment is to require BOTH — an observed print AND a
 *     dynamic print in the source of the unit that emitted it — which is
 *     strictly stronger than either alone. Not built here: it needs the
 *     emitting unit's source resolved per route, and getting that wrong
 *     mis-fails the nine guards that pass today.
 *   - **This module itself.** It is the observation harness, not a guard over
 *     the repo's state, and `guard-candidates.ts` does not discover it — no
 *     `*-guard.ts`/`*-audit.ts` filename, no `assert*`/`verify*`/`check*`/
 *     `audit*` export. That last one is a naming choice made deliberately
 *     rather than a coincidence: an earlier draft exported `checkEntrypoints`
 *     and `checkNeedsBaseRef`, discovery correctly admitted this file as an
 *     unclassified candidate, and the whole build went red. The exports are
 *     accessors and predicates, so `registeredCheckEntrypoints`/
 *     `needsMergeBase` is the honest name; the point of recording it here is
 *     that the alternative (classifying this file `isGuard: false` to make the
 *     red go away) would have been the self-serving move, and was not taken.
 *     The gate is `guard-denominator.test.ts`, which runs in CI under
 *     `pnpm run test` and prints its own denominator unconditionally — that
 *     line in the CI log is what makes this mechanism answerable to its own
 *     rule. Route 2 cannot cover it in any case: a sweep that runs its own
 *     test file as a child recurses forever.
 *   - **The `isGuard` classification itself.** A new guard could be kept out
 *     of this denominator entirely by classifying it `isGuard: false` in
 *     `guard-candidates.ts`. That is #1519's mechanism, and it requires a
 *     written reason a reviewer reads; nothing here re-litigates it.
 *
 * ## The baseline is a ratchet, not a bucket
 *
 * The grandfathered set lives in `cli/biffo.denominator-baseline.json`, and
 * `denominatorRatchet` compares the working copy against the copy at the
 * **merge base with `origin/dev`**. Removing an entry is an improvement;
 * **adding one is the failure**. The prosecution that rejected the first
 * version did so by adding a non-printing guard and exempting it one line
 * later in the same edit set — with a `Set<string>` living in the test file
 * there was nothing that could tell that apart from grandfathered debt,
 * because both look like "the file as it is now". Reading the base commit is
 * what makes the difference legible. Same posture as `checkOrphanRatchet`
 * (`core-upgrade.ts`, `biffo.orphan-baseline.json`) and `shared-files.json`'s
 * `skeletonAdoption`: never fail on the pre-existing residue, always fail on
 * a worsening, and report an improvement with an instruction to lower the
 * baseline, because a ratchet that never tightens stops meaning anything.
 */

const DENOMINATOR_VOCABULARY =
  /\b(examined|checked|audited|scanned|covered|considered|classified|discovered|counted|denominator|reached|analysed|analyzed|processed|swept|walked|visited|inspected|assessed|evaluated)\b/i

/**
 * Does one line of REAL, EMITTED output state a denominator? Vocabulary AND a
 * bare number on the same line — `audited 30 shell file(s)` passes, `audited
 * the plugin-allowlist naming convention` does not, because the second names
 * no count. The number must be a standalone token (`\b\d+\b`), so a digit
 * buried in a path segment or a version string cannot manufacture one.
 */
export function lineStatesADenominator(line: string): boolean {
  return DENOMINATOR_VOCABULARY.test(line) && /\b\d+\b/.test(line)
}

/** Any line of a captured stdout/stderr stream stating a denominator. */
export function outputStatesADenominator(output: string): boolean {
  return output.split('\n').some(lineStatesADenominator)
}

// ── Route 1: the CI-wired check commands ───────────────────────────────────

export interface CheckInvocation {
  /** Subcommand name, e.g. `pipe-trap`. */
  name: string
  /** Every wiring file this name was seen in. */
  sources: string[]
  /** True when at least one occurrence takes no further arguments — the form
   * this harness can reproduce. */
  bare: boolean
}

/** Directories whose files are read for `biffo.sh check <name>` invocations.
 * The wiring is what says a guard runs at all, so it is discovered rather
 * than listed — the same argument `guard-wiring-sweep.test.ts` (#1413) makes. */
const WIRING_DIRS = ['.github/workflows', '.githooks', 'scripts']

const INVOCATION_PATTERN = /biffo\.sh\s+check\s+([a-z0-9][a-z0-9-]*)(.*)$/

/**
 * Every `biffo.sh check <name>` invocation wired anywhere in this repo.
 *
 * A line is a plain text scan rather than a YAML/shell parse: these are shell
 * command lines embedded in three different file formats, and the thing being
 * identified — the literal command CI runs — is textual. Prose mentions in
 * comments are therefore also matched; they are harmless because a name is
 * marked `bare` if ANY occurrence of it takes no arguments, so a commentary
 * line can only ever add a name, never withdraw one.
 */
export function discoverCheckInvocations(repoRoot: string): CheckInvocation[] {
  const byName = new Map<string, CheckInvocation>()

  for (const dir of WIRING_DIRS) {
    const abs = join(repoRoot, dir)
    if (!existsSync(abs)) continue
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      let text: string
      try {
        text = readFileSync(join(abs, entry.name), 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        const m = INVOCATION_PATTERN.exec(line)
        if (!m) continue
        const name = m[1] as string
        const raw = (m[2] ?? '').trimEnd()
        // A trailing backslash is a line continuation, so the arguments are on
        // the NEXT line and this is emphatically not a bare invocation —
        // `scripts/shared-sync.sh` calls `check shared-file-reduction \` that
        // way. Stripping it as noise (an earlier version of this function did)
        // made an argument-only check look runnable, and it was then executed
        // with no arguments and recorded as "printed nothing", which is a wrong
        // answer rather than an honest skip.
        const continued = raw.endsWith('\\')
        // A closing backtick is markdown prose in a comment; `||` is a hook's
        // own error handling, not an argument.
        const rest = raw.replace(/`/g, '').trim()
        const bare = !continued && (rest === '' || rest.startsWith('||'))
        const existing = byName.get(name)
        if (existing) {
          existing.bare = existing.bare || bare
          if (!existing.sources.includes(`${dir}/${entry.name}`)) {
            existing.sources.push(`${dir}/${entry.name}`)
          }
        } else {
          byName.set(name, { name, sources: [`${dir}/${entry.name}`], bare })
        }
      }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Every module specifier a `.ts` file imports, read from the AST rather than
 * a regex over source text (#956). */
function importedSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []
  sourceFile.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    }
  })
  return specifiers
}

/**
 * Which `cli/src/scripts/check-*.ts` entrypoint each `biffo check <name>`
 * subcommand actually invokes, read from the command registry itself
 * (`cli/src/commands/check.ts`) rather than guessed from the subcommand name.
 *
 * Guessing `check-<name>.ts` is wrong and was wrong here: the `ownership`
 * subcommand runs `check-core-ownership.ts`. A guessed mapping silently
 * resolved to nothing, which meant that check could neither be credited with
 * its guard nor recognised as needing a merge base — a hand-derived second
 * copy of a relationship the registry already states, drifting from it
 * exactly the way this estate keeps re-finding.
 */
export function registeredCheckEntrypoints(commandsDir: string): Record<string, string[]> {
  const file = join(commandsDir, 'check.ts')
  if (!existsSync(file)) return {}
  const text = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)

  // Imported binding -> `check-*.ts` basename it came from.
  const bindingToScript = new Map<string, string>()
  sourceFile.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) return
    const script = /^\.\.\/scripts\/(check-[a-z0-9-]+)\.js$/.exec(node.moduleSpecifier.text)?.[1]
    if (script === undefined) return
    const bindings = node.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) bindingToScript.set(el.name.text, `${script}.ts`)
    }
  })

  // Each registration is one top-level expression statement:
  // `checkCommand.command('<name>') ... .action(async () => { await runXCheck(...) })`.
  // Take the name from the `.command('<name>')` call and the entrypoint from
  // whichever imported binding is referenced anywhere in that same statement.
  const entrypoints: Record<string, string[]> = {}
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement)) continue
    let name: string | null = null
    const scripts = new Set<string>()
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'command' &&
        node.arguments.length === 1 &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        name = (node.arguments[0] as ts.StringLiteralLike).text
      }
      if (ts.isIdentifier(node)) {
        const script = bindingToScript.get(node.text)
        if (script !== undefined) scripts.add(script)
      }
      node.forEachChild(visit)
    }
    visit(statement)
    if (name !== null && scripts.size > 0) entrypoints[name] = [...scripts].sort()
  }

  return entrypoints
}

/**
 * Which discovered guard module(s) a check subcommand actually runs, derived
 * from the `../lib/*.js` imports of its registered entrypoint. An unregistered
 * check yields none, so it credits nothing rather than silently crediting
 * everything.
 */
export function guardsRunByCheck(
  scriptsDir: string,
  entrypoints: readonly string[],
  guardFiles: readonly string[],
): string[] {
  const guards = new Set(guardFiles)
  const found = new Set<string>()
  for (const entry of entrypoints) {
    const path = join(scriptsDir, entry)
    if (!existsSync(path)) continue
    for (const specifier of importedSpecifiers(path)) {
      const base = /^\.\.\/lib\/(.+)\.js$/.exec(specifier)?.[1]
      if (base !== undefined && guards.has(`${base}.ts`)) found.add(`${base}.ts`)
    }
  }
  return [...found].sort()
}

/** True when a check entrypoint diffs against a merge base, so this harness
 * cannot drive it to a meaningful verdict (see the module docstring). */
export function needsMergeBase(scriptsDir: string, entrypoints: readonly string[]): boolean {
  return entrypoints.some((entry) => {
    const path = join(scriptsDir, entry)
    return existsSync(path) && readFileSync(path, 'utf8').includes('GITHUB_BASE_REF')
  })
}

export interface CommandRun {
  name: string
  /** stdout and stderr combined — guards legitimately report on either. */
  output: string
  /** Process exit status; `null` when it could not be started at all. */
  status: number | null
}

/** Run one check exactly as CI does. Never throws: a non-zero exit is a
 * result to record, not an error to propagate — a guard that fails here is
 * simply not observed to have printed anything. */
export function runCheckCommand(repoRoot: string, name: string): CommandRun {
  try {
    const output = execFileSync('sh', ['scripts/biffo.sh', 'check', name], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    })
    return { name, output, status: 0 }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number | null }
    return {
      name,
      output: `${err.stdout ?? ''}\n${err.stderr ?? ''}`,
      status: err.status ?? null,
    }
  }
}

// ── Route 2: the guard's own test pair, run for real ────────────────────────

/**
 * Split a `vitest run --reporter=verbose` transcript into the console output
 * each test FILE actually emitted. The reporter prefixes every intercepted
 * block with `stdout | <file> > <suite> > <test>` (or `stderr | ...`) and
 * terminates it with a blank line, which is the attribution this needs and
 * the reason `--reporter=verbose` is passed explicitly: the default reporter
 * suppresses console output entirely when stdout is not a TTY, so a harness
 * that relied on the default would observe silence from every guard and
 * report a uniform, meaningless zero.
 */
export function parseVitestConsoleByFile(transcript: string): Record<string, string> {
  const byFile: Record<string, string> = {}
  const lines = transcript.split('\n')
  let current: string | null = null

  for (const line of lines) {
    const header = /^(?:stdout|stderr) \| ([^\s|]+)/.exec(line)
    if (header) {
      current = header[1] as string
      byFile[current] ??= ''
      continue
    }
    if (current === null) continue
    if (line.trim() === '') {
      current = null
      continue
    }
    byFile[current] += `${line}\n`
  }

  return byFile
}

/**
 * Run the given test files in ONE child vitest and return what each printed.
 * `CI=true` is forced so the child never tries to take over a TTY, and the
 * transcript is returned even when the child exits non-zero — a failing guard
 * test is the main suite's problem, not this sweep's.
 */
export function runTestFilesAndCaptureConsole(
  cliDir: string,
  testFiles: readonly string[],
): Record<string, string> {
  if (testFiles.length === 0) return {}
  const bin = join(cliDir, 'node_modules', '.bin', 'vitest')
  let transcript: string
  try {
    transcript = execFileSync(bin, ['run', '--reporter=verbose', ...testFiles], {
      cwd: cliDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true' },
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string }
    transcript = `${err.stdout ?? ''}\n${err.stderr ?? ''}`
  }
  return parseVitestConsoleByFile(transcript)
}

// ── The observation itself ─────────────────────────────────────────────────

export interface DenominatorObservation {
  /** Guards observed printing a real count at runtime. */
  printing: string[]
  /** Guards that ran (by either route) and printed no count. */
  silent: string[]
  /** Check names executed, with whether their output stated a count. */
  commandsRun: { name: string; stated: boolean; status: number | null }[]
  /** Check names discovered in the wiring but deliberately not executed,
   * each with the reason — this is the "name what you skipped" half. */
  commandsSkipped: { name: string; reason: string }[]
}

/**
 * Run every observable execution route and report what was actually printed.
 *
 * `guardFiles` is `discoverGuardFiles(libDir)` — this never enumerates guards
 * itself. `selfTestFile` is excluded from route 2 for the obvious reason that
 * a sweep which runs its own test file recurses forever.
 */
export function observeDenominatorPrints(
  repoRoot: string,
  guardFiles: readonly string[],
  options: { selfTestFile?: string } = {},
): DenominatorObservation {
  const cliDir = join(repoRoot, 'cli')
  const libDir = join(cliDir, 'src', 'lib')
  const scriptsDir = join(cliDir, 'src', 'scripts')
  const registry = registeredCheckEntrypoints(join(cliDir, 'src', 'commands'))
  const printing = new Set<string>()
  const commandsRun: DenominatorObservation['commandsRun'] = []
  const commandsSkipped: DenominatorObservation['commandsSkipped'] = []

  // Route 1 — the CI-wired check commands.
  for (const invocation of discoverCheckInvocations(repoRoot)) {
    const entrypoints = registry[invocation.name] ?? []
    if (!invocation.bare) {
      commandsSkipped.push({
        name: invocation.name,
        reason: `only ever invoked with arguments (${invocation.sources.join(', ')})`,
      })
      continue
    }
    if (needsMergeBase(scriptsDir, entrypoints)) {
      commandsSkipped.push({
        name: invocation.name,
        reason: 'needs a merge base (reads GITHUB_BASE_REF); no meaningful base here',
      })
      continue
    }
    const run = runCheckCommand(repoRoot, invocation.name)
    const stated = run.status === 0 && outputStatesADenominator(run.output)
    commandsRun.push({ name: invocation.name, stated, status: run.status })
    if (stated) {
      for (const guard of guardsRunByCheck(scriptsDir, entrypoints, guardFiles)) {
        printing.add(guard)
      }
    }
  }

  // Route 2 — each guard's own test pair, in one child vitest.
  const pairs = new Map<string, string>()
  for (const guard of guardFiles) {
    const testFile = `src/lib/${guard.replace(/\.ts$/, '.test.ts')}`
    if (options.selfTestFile !== undefined && testFile.endsWith(options.selfTestFile)) continue
    if (existsSync(join(libDir, guard.replace(/\.ts$/, '.test.ts')))) pairs.set(testFile, guard)
  }
  const consoleByFile = runTestFilesAndCaptureConsole(cliDir, [...pairs.keys()])
  for (const [testFile, guard] of pairs) {
    if (outputStatesADenominator(consoleByFile[testFile] ?? '')) printing.add(guard)
  }

  return {
    printing: guardFiles.filter((g) => printing.has(g)),
    silent: guardFiles.filter((g) => !printing.has(g)),
    commandsRun,
    commandsSkipped,
  }
}

// ── The baseline, and the ratchet that only lets it shrink ─────────────────

/** Repo-relative path of the grandfathered set. Beside the guards it is about
 * rather than at the repo root, because it is a `cli/` development artefact
 * and not something a scaffolded instance ever reads. */
export const DENOMINATOR_BASELINE_FILE = 'cli/biffo.denominator-baseline.json'

/**
 * Parse a baseline document. A malformed file THROWS rather than degrading to
 * an empty set, for the same reason `readOrphanBaseline` does: silently
 * reading broken config as "no baseline" would turn a config error into
 * either a surprise hard block or — far worse here — a silently empty
 * comparison that lets an addition through.
 */
export function parseDenominatorBaseline(text: string, label: string): string[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${(err as Error).message}`)
  }
  const entries = (raw as { noDenominator?: unknown })?.noDenominator
  if (!Array.isArray(entries) || entries.some((e) => typeof e !== 'string')) {
    throw new Error(`${label} is invalid: expected { "noDenominator": string[] }`)
  }
  return [...(entries as string[])].sort()
}

/** The working-tree baseline. */
export function readDenominatorBaseline(repoRoot: string): string[] {
  const path = join(repoRoot, DENOMINATOR_BASELINE_FILE)
  return parseDenominatorBaseline(readFileSync(path, 'utf8'), DENOMINATOR_BASELINE_FILE)
}

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

/**
 * The commit this branch's baseline must be judged against: the merge base
 * with the integration branch, NOT that branch's tip. Using the tip would
 * report a *shrink* that landed on `dev` after you branched as though your
 * older, larger baseline had grown — a false failure nobody could act on.
 *
 * `origin/$GITHUB_BASE_REF` first (the estate's existing convention, see
 * `check-core-ownership.ts`), then `origin/dev`, then a local `dev`. Returns
 * `null` when none of them resolve, which callers must treat as **cannot
 * tell** — never as a pass.
 */
export function resolveBaselineBaseCommit(repoRoot: string): string | null {
  const base = process.env['GITHUB_BASE_REF']
  const candidates = [
    ...(base !== undefined && base !== '' ? [`origin/${base}`] : []),
    'origin/dev',
    'dev',
  ]
  for (const ref of candidates) {
    const resolved = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    if (resolved === null || resolved.trim() === '') continue
    const mergeBase = git(repoRoot, ['merge-base', 'HEAD', ref])
    // A repo with no shared history (a fixture built from two roots) still
    // gets a usable comparison from the ref itself.
    return (mergeBase ?? resolved).trim()
  }
  return null
}

/**
 * The baseline as it stood at `commit`. `null` means the file did not exist
 * there — the establishing case, which is a pass. Distinguishing that from
 * "git could not answer at all" is the whole reason the caller resolves the
 * commit separately: an unresolvable base is cannot-tell and must fail.
 */
export function readDenominatorBaselineAt(
  repoRoot: string,
  commit: string,
  relPath: string = DENOMINATOR_BASELINE_FILE,
): string[] | null {
  const text = git(repoRoot, ['show', `${commit}:${relPath}`])
  if (text === null) return null
  return parseDenominatorBaseline(text, `${relPath} at ${commit}`)
}

/**
 * Which baseline entries name a guard file that did **not** exist at the base
 * commit — i.e. a guard this branch is introducing and grandfathering in the
 * same breath.
 *
 * This is the condition that closes the bootstrap hole in the addition check
 * above. On the PR that first introduces the baseline file there is nothing to
 * diff against, so "the list did not grow" is vacuously true and the exact
 * attack that broke the previous version of this gate — add a non-printing
 * guard, exempt it one line later — would succeed once, on the very change
 * that is supposed to stop it. Asking instead whether each grandfathered guard
 * *predates the base commit* needs no earlier copy of the baseline, so it
 * binds on the establishing run too, and it expresses the actual rule more
 * directly: the baseline records pre-existing debt, and a file this branch
 * created is not pre-existing.
 *
 * A rename of a baselined guard trips this deliberately. A rename is a
 * modification, and #1363's closing condition is that a **new or modified**
 * gate must state its denominator — so the answer there is to give it one,
 * not to carry the exemption across to the new name.
 */
export function baselineEntriesAbsentAtBase(
  repoRoot: string,
  commit: string,
  entries: readonly string[],
  libRelDir = 'cli/src/lib',
): string[] {
  return entries
    .filter(
      (entry) => git(repoRoot, ['cat-file', '-e', `${commit}:${libRelDir}/${entry}`]) === null,
    )
    .sort()
}

export interface DenominatorRatchet {
  /** Entries this branch ADDED. Non-empty is the failure — a PR may not
   * grandfather a guard it is introducing. */
  added: string[]
  /** Entries this branch removed. Reported, never failed. */
  removed: string[]
  /** True when no baseline existed at the base commit, so there is nothing to
   * ratchet against yet. */
  establishing: boolean
}

/** Pure comparison, so the pass/fail decision is unit-testable without git. */
export function denominatorRatchet(
  working: readonly string[],
  base: readonly string[] | null,
): DenominatorRatchet {
  if (base === null) return { added: [], removed: [], establishing: true }
  const baseSet = new Set(base)
  const workingSet = new Set(working)
  return {
    added: [...working].filter((f) => !baseSet.has(f)).sort(),
    removed: [...base].filter((f) => !workingSet.has(f)).sort(),
    establishing: false,
  }
}
