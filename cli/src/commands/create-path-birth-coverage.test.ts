import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { coreCommand } from './core.js'
import { dataCommand } from './data.js'
import { deployCommand } from './deploy.js'
import { destroyCommand } from './destroy.js'
import { initCommand } from './init.js'
import { pluginCommand } from './plugin.js'
import { siblingCommand } from './sibling.js'
import { checkCommand } from './check.js'
import { doctorCommand } from './doctor.js'
import { teardownCommand } from './teardown.js'
import { hookAuditCommand } from './hook-audit.js'
import { pgTestDbCommand } from './pg-test-db.js'
import { pgtestDiffCheckCommand } from './pgtest-diff-check.js'
import { rewriteScopeCheckCommand } from './rewrite-scope-check.js'
import { gateCoverageCommand } from './gate-coverage.js'
import { verifyCommand } from './verify.js'
import { branchHealthCommand } from './branch-health.js'
import { claimCommand } from './claim.js'
import { waitForChecksCommand } from './wait-for-checks.js'
import { runnerDropForensicsCommand } from './runner-drop-forensics.js'

const commandsDir = dirname(fileURLToPath(import.meta.url))

/**
 * The class-level guard for #1459: **every create path must produce a repo
 * that can perform its second action**, and that has to be discovered by
 * ENUMERATION, not by hand-maintaining a list of the paths we happened to
 * know about — a hand-written list is exactly how `sibling-create.ts`'s
 * `.biffo-shared-version` stamp went unasked-about for weeks after the
 * identical question was asked (and answered wrong) on the plugin path
 * (#1449/#1473).
 *
 * The full command tree below is the SAME set of top-level commands
 * `index.ts` registers on the real `program` — deliberately not a subset —
 * so a new top-level command wired up there is automatically walked here
 * too. `index.ts` itself is never imported (it calls `program.parseAsync()`
 * at module load), so this rebuilds the same tree from the same command
 * modules without ever parsing argv.
 *
 * "Create path" is discovered two ways:
 *   - any subcommand literally named `create`, found anywhere in the tree
 *     (today: `plugin create`, `sibling create`) — this is what makes the
 *     enumeration extend to a FUTURE create path with no manifest edit
 *     needed beyond adding its birth-test entry below;
 *   - the top-level `init` command, included explicitly because it does not
 *     follow the `create` naming convention despite being the third path
 *     named in #1459's own enumeration.
 */
function walkForCreatePaths(command: Command, prefix: string[] = []): string[] {
  const path = [...prefix, command.name()]
  const here = command.name() === 'create' ? [path.join(' ')] : []
  return command.commands.reduce((acc, sub) => [...acc, ...walkForCreatePaths(sub, path)], here)
}

const ROOT_COMMANDS: Command[] = [
  initCommand,
  deployCommand,
  destroyCommand,
  teardownCommand,
  waitForChecksCommand,
  branchHealthCommand,
  claimCommand,
  verifyCommand,
  gateCoverageCommand,
  runnerDropForensicsCommand,
  hookAuditCommand,
  pgTestDbCommand,
  pgtestDiffCheckCommand,
  rewriteScopeCheckCommand,
  pluginCommand,
  dataCommand,
  coreCommand,
  siblingCommand,
  checkCommand,
  doctorCommand,
]

const CREATE_PATHS = [
  'init',
  ...ROOT_COMMANDS.filter((c) => c !== initCommand).flatMap((c) => walkForCreatePaths(c)),
].sort()

/**
 * One entry per enumerated create path. `birthTest: null` is only ever
 * correct with a `reason` explaining precisely why the path cannot be
 * birth-tested — never as a silent opt-out, and never because the test would
 * be inconvenient to write.
 */
const BIRTH_COVERAGE: Record<string, { birthTest: string | null; reason?: string }> = {
  init: {
    birthTest: null,
    reason:
      "biffo init's repo creation (createRepoFromTemplate) and its second commit " +
      '(writeInstanceFiles, via github.commitFiles) both happen entirely through the ' +
      'GitHub REST API against a real org — there is no local scaffold-then-git-commit ' +
      'step to exercise offline the way plugin/sibling create have. It needs real ' +
      'GitHub (and AWS, for the OIDC/backend steps in between) and cannot run in CI ' +
      "without live credentials. Partial mitigation: init's OWN second GitHub repo — " +
      'the root app sibling created at step 6 — is provisioned through the exact same ' +
      "runSiblingCreate/writeSiblingTemplate code path 'sibling create' uses, so " +
      'sibling-create-birth.test.ts covers that half by construction, not by a separate test.',
  },
  'plugin create': { birthTest: 'plugin-create-birth.test.ts' },
  'sibling create': { birthTest: 'sibling-create-birth.test.ts' },
}

describe('create-path birth-test coverage (#1459)', () => {
  it('enumerates every create path found in the real command tree', () => {
    // The count is asserted AND printed — #1459 asked explicitly not to trust
    // a hand-written list. If this changes, a create path was added (or
    // renamed) and BIRTH_COVERAGE below needs a new entry before this test
    // will pass again.
    console.log(`create paths found: ${CREATE_PATHS.length} — ${CREATE_PATHS.join(', ')}`)
    expect(CREATE_PATHS).toEqual(['init', 'plugin create', 'sibling create'])
  })

  it.each(CREATE_PATHS)('%s has a birth-coverage decision recorded', (path) => {
    expect(BIRTH_COVERAGE).toHaveProperty(path)
  })

  it('has no stale coverage entries for paths that no longer exist', () => {
    expect(Object.keys(BIRTH_COVERAGE).sort()).toEqual(CREATE_PATHS)
  })

  it.each(Object.entries(BIRTH_COVERAGE).filter(([, v]) => v.birthTest !== null))(
    "%s's declared birth test file actually exists",
    (path, coverage) => {
      const testPath = join(commandsDir, coverage.birthTest!)
      expect(existsSync(testPath), `${coverage.birthTest} does not exist for '${path}'`).toBe(true)
    },
  )

  it('every skipped path names a reason', () => {
    for (const [path, coverage] of Object.entries(BIRTH_COVERAGE)) {
      if (coverage.birthTest === null) {
        expect(coverage.reason, `'${path}' has no birth test and no reason recorded`).toBeTruthy()
      }
    }
  })

  /**
   * `ROOT_COMMANDS` above is a SECOND COPY of what `index.ts` registers on the
   * real `program`, and the docstring at the top of this file asserts the two
   * are the same set. Nothing checked that, which made this guard an instance
   * of the very class it belongs to (#1362: a guard resolving its answer from a
   * different document than the actor).
   *
   * The failure it admits is silent and shrinks the denominator: add a
   * top-level command to `index.ts` that owns a `create` subcommand, forget to
   * list it here, and `CREATE_PATHS` simply never sees it. Every assertion above
   * still passes — over a set with a hole in it. That is #1459's own founding
   * mistake (a hand-maintained list of create paths) reappearing one level up,
   * and #1363's (a green result over an unprinted denominator).
   *
   * `index.ts` cannot be imported — it calls `program.parseAsync()` at module
   * load — so this reads its source and compares the identifiers it passes to
   * `addCommand(...)` against the ones assembled here.
   */
  it('ROOT_COMMANDS matches every command index.ts registers', () => {
    const indexSource = readFileSync(join(commandsDir, '..', 'index.ts'), 'utf8')
    const registered = [...indexSource.matchAll(/addCommand\(\s*([A-Za-z_$][\w$]*)/g)]
      .map((m) => m[1])
      .sort()

    // Guard the guard: a regex that matched nothing would make this pass
    // vacuously, which is the failure mode being fixed.
    expect(registered.length, 'found no addCommand() calls in index.ts').toBeGreaterThan(0)
    expect(new Set(registered).size, 'index.ts registers a command twice').toBe(registered.length)

    const walked = ROOT_COMMANDS.map((c) => c.name()).sort()
    const registeredNames = registered
      .map((ident) =>
        ident.replace(/Command$/, '').replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`),
      )
      .sort()

    expect(
      walked.length,
      `index.ts registers ${registered.length} commands, ROOT_COMMANDS has ${walked.length}`,
    ).toBe(registered.length)
    expect(walked).toEqual(registeredNames)
  })
})
