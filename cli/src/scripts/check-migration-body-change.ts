/**
 * Runner for the #751 body-change marker guard. Template-only: an instance's
 * `services/api/migrations/versions/` is a carried, user-owned copy (ADR-0006),
 * not the source this guard is protecting — see `migration-body-change-guard.ts`
 * for the decision logic and why it stops at "marker present or not" rather
 * than acting on the classification.
 *
 * CI mode only (unlike `check-core-ownership.ts`, there is no `--staged` /
 * commit-hook mode here): the guard needs the migration's content at the
 * *merge base*, which a pre-commit hook cannot see for a file the working
 * branch has already checked out over.
 */
import { execa } from '../lib/exec.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { INSTANCE_CORE_FILE, isInstanceRepo } from '../lib/core-version.js'
import { MIGRATIONS_VERSIONS_DIR } from '../lib/core-migrations.js'
import {
  checkMigrationBodyChangeMarkers,
  type MigrationBodyChangeDiff,
} from '../lib/migration-body-change-guard.js'

const BOLD = '[1m'
const DIM = '[2m'
const RED = '[31m'
const GREEN = '[32m'
const YELLOW = '[33m'
const OFF = '[0m'

/** `git show <ref>:<path>`, or `null` when the path does not exist at that ref
 * (the normal case for a file added or deleted by this PR). */
async function showAt(ref: string, path: string, cwd: string): Promise<string | null> {
  const result = await execa('git', ['show', `${ref}:${path}`], { cwd, reject: false })
  return result.exitCode === 0 ? result.stdout : null
}

export async function runMigrationBodyChangeCheck(argv: string[]): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  if (isInstanceRepo(root)) {
    console.log(
      `✓ migration body-change guard: skipped — this is an instance (${INSTANCE_CORE_FILE} ` +
        'present). Its migrations/versions/ is a carried, user-owned copy, not the template ' +
        'source this guard protects.',
    )
    return
  }

  if (!existsSync(join(root, MIGRATIONS_VERSIONS_DIR))) {
    console.log(`✓ migration body-change guard: no ${MIGRATIONS_VERSIONS_DIR} in this repo.`)
    return
  }

  const base = process.env['GITHUB_BASE_REF'] ?? argv[0]
  if (!base) {
    console.error('No base ref: set GITHUB_BASE_REF or pass a base branch as the first argument.')
    process.exit(2)
  }

  await execa('git', ['fetch', '--quiet', 'origin', base], { cwd: root, reject: false })

  // --no-renames: a renamed-and-edited migration then reads as a delete plus
  // an add, neither of which this guard examines (see MigrationBodyChangeDiff's
  // doc) rather than as a body change it might wrongly wave through under a
  // stale marker carried across the rename. Narrower coverage, not a false pass.
  const { stdout } = await execa(
    'git',
    [
      'diff',
      '--no-renames',
      '--name-status',
      `origin/${base}...HEAD`,
      '--',
      MIGRATIONS_VERSIONS_DIR,
    ],
    { cwd: root },
  )

  const candidates: { file: string; status: string }[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t').filter(Boolean)
    const status = parts[0]
    const path = parts[parts.length - 1]
    if (!status || !path || parts.length < 2) continue
    if (!path.endsWith('.py') || path.endsWith('/__init__.py')) continue
    candidates.push({ file: path, status })
  }

  const diffs: MigrationBodyChangeDiff[] = []
  for (const { file, status } of candidates) {
    if (status.startsWith('A')) {
      diffs.push({
        file,
        status: 'added',
        oldContent: null,
        newContent: await showAt('HEAD', file, root),
      })
    } else if (status.startsWith('M')) {
      const [oldContent, newContent] = await Promise.all([
        showAt(`origin/${base}`, file, root),
        showAt('HEAD', file, root),
      ])
      diffs.push({ file, status: 'modified', oldContent, newContent })
    } else if (status.startsWith('D')) {
      diffs.push({
        file,
        status: 'deleted',
        oldContent: await showAt(`origin/${base}`, file, root),
        newContent: null,
      })
    }
    // R/C do not occur with --no-renames.
  }

  const result = checkMigrationBodyChangeMarkers(diffs)

  // The denominator, printed unconditionally — see MigrationBodyChangeCheckResult.examined's
  // doc. A run that touches no migration prints "examined 0" rather than saying nothing.
  console.log(
    `${DIM}migration body-change guard: examined ${result.examined} already-released ` +
      `migration file(s) changed in this PR` +
      (result.exemptAdded.length > 0
        ? ` (+${result.exemptAdded.length} newly added, exempt)`
        : '') +
      `.${OFF}`,
  )

  for (const { file, classification } of result.declared) {
    console.log(`  ${GREEN}declared${OFF}   ${file} ${DIM}→ ${classification}${OFF}`)
  }

  if (result.violations.length === 0) {
    console.log(`${GREEN}✓ migration body-change guard: no undeclared body changes.${OFF}`)
    return
  }

  console.error(
    `\n${RED}${BOLD}✗ This PR changes an already-released migration's body with no declaration.${OFF}\n`,
  )
  for (const { file, reason } of result.violations) {
    console.error(`  ${RED}${file}${OFF}\n    ${DIM}${reason}${OFF}`)
  }
  console.error(`
${BOLD}Why this is blocked${OFF}
  An applied migration cannot be re-run, so a body edit here never reaches an
  instance that already carried it (#739) — silently, unless a template author
  says whether that is safe (docs/guides/core-upgrade.md, "When the template
  edits a migration you already have"). ${YELLOW}#931${OFF} shows the safe case: a
  docstring-only addendum, which this guard never flags, because it compares
  the same hashed body \`core-upgrade\` itself compares — DDL, not prose.

${BOLD}What to do${OFF}
  Add a marker to the migration, above or beside the edited DDL:

    ${DIM}# biffo:body-change: replay-safe — <why an applied database is already correct>${OFF}
    ${DIM}# biffo:body-change: outcome-changing — <why an applied database is now wrong>${OFF}

  Use ${DIM}replay-safe${OFF} when re-stating the DDL changes nothing about a database
  that already ran the old body (a guard, an idempotency check, #670's own
  fix). Use ${DIM}outcome-changing${OFF} when it does not — an already-applied
  instance's schema is now actually wrong, and only a follow-on migration
  converges it. Neither label is enforced yet (#751 is reporting-only, pending
  more examples) — but recording it now is what lets that decision be made
  later instead of never.
`)
  process.exit(1)
}
