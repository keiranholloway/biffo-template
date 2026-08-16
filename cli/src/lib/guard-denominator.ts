import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
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
 * ## One execution route. The second was deleted, and the deletion is measured
 *
 * A guard is credited only if a line **actually emitted** by its CI-wired
 * check command states a count (denominator vocabulary AND a bare number on
 * the same line). `sh scripts/biffo.sh check <name>` is literally what
 * `ci.yml` runs — in the template that bridge execs the working tree's `cli/`
 * through tsx, so this observes THIS branch's guards against THIS repo, not a
 * published release. The invocations are discovered by reading the wiring
 * files (`.github/workflows/`, `.githooks/`, `scripts/`), never listed here. A
 * check is mapped back to the guard module(s) its
 * `cli/src/scripts/check-<name>.ts` entrypoint imports, read from the
 * TypeScript AST (#956).
 *
 * **There used to be a second route** — run each guard's own same-basename
 * `*.test.ts` in a child `vitest run --reporter=verbose` and attribute console
 * output per test FILE, using the reporter's `stdout | <file> > <test>`
 * header. A pre-merge prosecution broke it: attribution by file cannot tell a
 * count the *guard* emitted from a count its *test* emitted, so a guard whose
 * source prints nothing passed if its paired test contained
 * `console.log('examined 999 item(s)')` in an `it()` that never exercised it.
 * The test file and the guard are written by the same PR, so that is not a
 * corner case — it is a one-line forge.
 *
 * It was deleted rather than repaired, and the deciding fact is a measurement,
 * not a preference: **route 2 credited zero of the 25 discovered guards**, and
 * **zero of the 25 guard `*.test.ts` files contain a `console.` call at all**
 * (`grep -c 'console\.' cli/src/lib/<guard>.test.ts` over the discovered set).
 * It was machinery with no users — a full child vitest run per sweep, whose
 * only measurable effect on any real input was the forge above. Removing it
 * does not move the credited figure by one guard. Attribution *could* have
 * been made sound instead (a `--setupFiles` shim wrapping `console.*` and
 * reading the caller's frame off `new Error().stack` does resolve to the
 * original `.ts` path under vitest 4 — verified before choosing), but building
 * a sound mechanism for zero callers is #1413's own defect, in the change
 * about denominators.
 *
 * The consequence is deliberate and makes the gate **stricter**: a new guard
 * is now credited only by being wired into CI as a `biffo check` subcommand.
 * The previous docstring argued that "a gate that can only be satisfied by
 * editing a workflow is a gate people route around". That argument is
 * retired — a guard nothing in CI invokes is exactly #1413's "guards with zero
 * callers", so requiring the wiring is the correct demand rather than friction
 * to be designed around.
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
 *   - **A count printed anywhere other than a wired check's own output.**
 *     `template-owned-scope.test.ts` prints a real count for
 *     `terraform-input-guard.findWorkflowFiles`; it credits nobody here, and
 *     since route 2's removal no test file's output credits anything at all.
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
 *     rule.
 *   - **The `isGuard` classification itself.** A new guard could be kept out
 *     of this denominator entirely by classifying it `isGuard: false` in
 *     `guard-candidates.ts`. That is #1519's mechanism, and it requires a
 *     written reason a reviewer reads; nothing here re-litigates it.
 *
 * ## What MEASURES comes from the base ref. What is MEASURED comes from HEAD
 *
 * A second pre-merge prosecution broke the version before this one without
 * touching the baseline at all: **one line** changed in
 * `resolveBaselineBaseCommit`, so that the merge base resolved to the PR's own
 * `HEAD` instead of `origin/dev`. The ratchet then compared the baseline
 * against itself, and a brand-new non-printing guard — grandfathered by the
 * very PR introducing it — went fully green.
 *
 * That is not a bug in that function. It is the general property the
 * prosecutor named: **no guard executed from the PR's own checkout can bind a
 * PR that edits it.** Two rounds of cleverer detection each invited the next
 * bypass, so this round changes the shape instead of sharpening the detector.
 *
 * `guard-denominator.test.ts` resolves the merge base, then extracts THIS
 * FILE as it stands at that commit and imports it. Base's copy supplies the
 * verdict: the vocabulary, the observation, the ratchet comparison, the
 * absent-at-base check. A PR editing this file therefore changes what is
 * **measured** (its guards, its baseline) but not what **measures**. Widening
 * `DENOMINATOR_VOCABULARY`, short-circuiting `outputStatesADenominator`,
 * making `guardsRunByCheck` credit everything, or the one-line merge-base edit
 * above are all now edits to a copy that does not run.
 *
 * ### The root of trust, named rather than hidden
 *
 * Something has to bootstrap, and that something is in the head checkout: the
 * test file resolves the base commit before it can load anything from it.
 * Rather than trust that resolution, the test **verifies its result** against
 * a property a branch cannot fabricate — the resolved commit must be
 * contained in the remote integration branch (`git merge-base --is-ancestor`),
 * must not be `HEAD`, and must have been reached via a ref on the allowed
 * integration list. The prosecutor's exact attack fails on the first of those:
 * `HEAD` is not an ancestor of `origin/dev`, so resolving to it is caught by a
 * check that never asks how the resolution was computed. `resolveBaselineBase`
 * returns the ref alongside the commit precisely so the caller can check both.
 *
 * **What still is not bound, stated plainly.** `guard-denominator.test.ts`
 * itself runs from the head checkout and could simply be edited to skip all of
 * the above — as could `vitest.config.ts`, `package.json`, or `ci.yml`, since
 * a `pull_request` run uses the PR's own copy of every one of them. There is
 * no arrangement of files inside a repository that binds a PR able to edit
 * that repository; closing it needs something outside the checkout (a
 * CODEOWNERS review requirement on these paths, or a `pull_request_target`
 * job running the base's workflow), which is not a `cli/` change and is not
 * claimed here. What this shape buys is narrower and real: the cheap,
 * plausible-looking, one-line edit no longer works, and the remaining bypass
 * is a visible deletion of the base-ref load in a file whose only purpose is
 * this gate.
 *
 * ### Why an acknowledgement trailer was considered and not taken
 *
 * The alternative direction was to require a `Core-Divergence`-style trailer
 * whenever this file or the baseline differs from base — not preventing the
 * edit, just making it non-silent. It is rejected as the *primary* mechanism
 * because its cost falls entirely on the honest path: a maintainer improving
 * this gate is blocked until they edit the PR body, while an attacker types
 * the same line and proceeds. It buys visibility, which is obtained here for
 * free instead — the sweep prints, unconditionally and on green runs, which
 * commit supplied the mechanism and whether head's copy differs from it. The
 * "which document acted, and from which revision" question is answered in the
 * CI log rather than enforced by ceremony.
 *
 * ### The establishing run is not bound by this, and cannot be
 *
 * On the PR that introduces this file there is no copy at the base commit to
 * load, so head's copy runs and says so loudly. That hole is real and
 * unavoidable — it is the same bootstrap the baseline ratchet has, one level
 * up. The mitigating fact is that it is the *safest* instance of the failure
 * mode it concerns: the danger being guarded against is a one-line edit buried
 * in an existing file, and on the establishing run the whole file is new and
 * read in full by a reviewer. Every PR after this one is judged by base's copy.
 *
 * ### A mechanism edit must still pass its own new rules
 *
 * Loading the verdict from base creates a hazard in the other direction: an
 * edit to this file would otherwise never be exercised by the run that merges
 * it, landing untested and taking effect on `dev` afterwards — the estate's
 * recorded "guard and authority disagree, because they are two revisions of
 * one file" shape. So when head's copy differs from base's, the sweep runs
 * BOTH and requires both to pass. Base's copy is what a failure is attributed
 * to; head's copy failing means the edit is broken and may not land.
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
 * A count, as opposed to a digit that merely occurs. The number must be
 * delimited by whitespace (or the line's edge) on the left and by whitespace
 * or closing punctuation on the right.
 *
 * **This used to be `\b\d+\b`, and the docstring above it claimed that "a
 * digit buried in a path segment or a version string cannot manufacture one".
 * That claim was false**, and the attack rig built to prosecute this change
 * found it by accident: run from a checkout under
 * `/tmp/claude-1000/…`, the line
 *
 *     audited the plugin-allowlist naming convention under /tmp/claude-1000/…
 *
 * was credited as a denominator, because `\b` matches between `-` and `1` and
 * so `claude-1000` supplied `1000`. `plugin-allowlist-convention` is in the
 * baseline precisely because it states no count, and it silently left the
 * baseline whenever the repository sat under a path containing a number.
 *
 * The number of guards credited was therefore a function of the absolute path
 * the suite ran from — a denominator that changes with the working directory,
 * in the mechanism written to stop denominators being meaningless. Every one
 * of the nine lines actually credited today writes its count space-delimited
 * and immediately after the vocabulary word (`audited 30 shell file(s)`), so
 * this is a strict tightening with no observed cost.
 */
const BARE_COUNT = /(?:^|\s)\d+(?:$|[\s),.;:])/

/**
 * Does one line of REAL, EMITTED output state a denominator? Denominator
 * vocabulary AND a bare count on the same line — `audited 30 shell file(s)`
 * passes, `audited the plugin-allowlist naming convention under /repo-2` does
 * not, because the second names no count.
 *
 * It deliberately does NOT require the count to be adjacent to the vocabulary
 * word: `12 path(s) reached` is as honest a statement as `reached 12 path(s)`,
 * and a window would have to be tuned, which is the sharpening-the-detector
 * move this change exists to stop doing.
 */
export function lineStatesADenominator(line: string): boolean {
  return DENOMINATOR_VOCABULARY.test(line) && BARE_COUNT.test(line)
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
 * Run every CI-wired check this harness can drive, and report what was
 * actually printed.
 *
 * `guardFiles` is `discoverGuardFiles(libDir)` — this never enumerates guards
 * itself.
 */
export function observeDenominatorPrints(
  repoRoot: string,
  guardFiles: readonly string[],
): DenominatorObservation {
  const cliDir = join(repoRoot, 'cli')
  const scriptsDir = join(cliDir, 'src', 'scripts')
  const registry = registeredCheckEntrypoints(join(cliDir, 'src', 'commands'))
  const printing = new Set<string>()
  const commandsRun: DenominatorObservation['commandsRun'] = []
  const commandsSkipped: DenominatorObservation['commandsSkipped'] = []

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

/** This file. The sweep loads the copy at the merge base and lets THAT copy
 * decide, so the module has to be able to name itself. */
export const DENOMINATOR_MECHANISM_FILE = 'cli/src/lib/guard-denominator.ts'

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
 * The refs this sweep is willing to treat as the integration branch, in
 * preference order: `origin/$GITHUB_BASE_REF` (the estate's existing
 * convention, see `check-core-ownership.ts`), then `origin/dev`, then a local
 * `dev` for a workstation with no fetched remote.
 *
 * Exported, and taking the environment as an argument, so that a caller can
 * recompute the list independently and check that the ref a resolution claims
 * to have used is actually on it. `GITHUB_BASE_REF` is set by the Actions
 * runner rather than by the checkout, which is what makes it worth preferring.
 */
export function integrationRefCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const base = env['GITHUB_BASE_REF']
  return [
    ...new Set([
      ...(base !== undefined && base !== '' ? [`origin/${base}`] : []),
      'origin/dev',
      'dev',
    ]),
  ]
}

export interface BaselineBase {
  /** The merge-base commit this branch is judged against. */
  commit: string
  /** The integration ref it was derived from — checkable by the caller. */
  ref: string
}

/**
 * The commit this branch is judged against: the merge base with the
 * integration branch, NOT that branch's tip. Using the tip would report a
 * *shrink* that landed on `dev` after you branched as though your older,
 * larger baseline had grown — a false failure nobody could act on.
 *
 * Returns `null` when no candidate ref resolves, which callers must treat as
 * **cannot tell** — never as a pass.
 *
 * **Callers must verify the result rather than trust it** — see
 * `baseCommitIsContainedIn`. A one-line edit here returning `HEAD` is exactly
 * how the previous version of this gate was defeated, and no amount of care
 * inside this function prevents that, because the attacker rewrites the
 * function. What defeats it is checking the answer against a property of the
 * repository the branch does not control.
 */
export function resolveBaselineBase(repoRoot: string): BaselineBase | null {
  for (const ref of integrationRefCandidates()) {
    const resolved = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    if (resolved === null || resolved.trim() === '') continue
    const mergeBase = git(repoRoot, ['merge-base', 'HEAD', ref])
    // A repo with no shared history (a fixture built from two roots) still
    // gets a usable comparison from the ref itself.
    return { commit: (mergeBase ?? resolved).trim(), ref }
  }
  return null
}

/** The commit `HEAD` currently names, or `null` if git cannot say. */
export function resolveHeadCommit(repoRoot: string): string | null {
  return git(repoRoot, ['rev-parse', 'HEAD'])?.trim() ?? null
}

/**
 * Is `commit` already contained in `ref` — i.e. is it a commit that the
 * integration branch already carries, and therefore one this branch cannot
 * have authored?
 *
 * This is the check that makes the base-commit resolution trustworthy without
 * trusting the resolver. Any commit unique to the PR branch — `HEAD`, `HEAD^`,
 * the commit that introduced a new non-printing guard — fails it, because it
 * is by definition not yet on `origin/dev`. It asks nothing about *how* the
 * commit was chosen, which is the whole point: the previous defeat rewrote the
 * choosing.
 */
export function baseCommitIsContainedIn(repoRoot: string, commit: string, ref: string): boolean {
  // `--is-ancestor` answers through the exit status and prints nothing, so
  // `git()` returns '' for yes and null for no. Worth stating: a helper that
  // read "no output" as "cannot tell" would invert this check silently.
  return git(repoRoot, ['merge-base', '--is-ancestor', commit, ref]) !== null
}

/**
 * This file, as it stands at `commit`, written somewhere importable and
 * returned — or `null` when the path did not exist there (the establishing
 * case, which callers must report rather than treat as agreement).
 *
 * `destDir` should be a temp directory: bare specifiers still resolve from
 * outside the package root under vitest's transform pipeline (verified), and
 * writing into `cli/src/` instead would put an untracked module where guard
 * discovery, lint and typecheck can all see it mid-run.
 */
export function extractFileAtCommit(
  repoRoot: string,
  commit: string,
  relPath: string,
  destDir: string,
): string | null {
  const text = git(repoRoot, ['show', `${commit}:${relPath}`])
  if (text === null) return null
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, `base-${commit.slice(0, 12)}-${basename(relPath)}`)
  writeFileSync(dest, text)
  return dest
}

/** Blob SHA of `relPath` at `commit`, or `null` when absent — the cheap way to
 * say whether head's copy of the mechanism differs from base's, and the value
 * printed in the CI log so the acting revision is a matter of record. */
export function blobShaAtCommit(repoRoot: string, commit: string, relPath: string): string | null {
  return git(repoRoot, ['rev-parse', `${commit}:${relPath}`])?.trim() ?? null
}

/** Blob SHA of a working-tree file, computed the same way git would. */
export function blobShaOfWorkingFile(repoRoot: string, relPath: string): string | null {
  return git(repoRoot, ['hash-object', relPath])?.trim() ?? null
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
