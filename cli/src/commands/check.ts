import { Command } from 'commander'
import { runOwnershipCheck } from '../scripts/check-core-ownership.js'
import { runPluginTerraformCheck } from '../scripts/check-plugin-terraform.js'
import { runReleaseSubjectCheck } from '../scripts/check-release-subject.js'

/**
 * The repo guards, as CLI subcommands.
 *
 * These used to be reachable only as package.json scripts (`pnpm --filter
 * @biffo/cli check:core-ownership`), which meant every instance had to carry
 * `cli/` to run them — 31k lines of a scaffolding tool an instance never
 * develops and never deploys, built, linted, type-checked and tested in every
 * tenant's CI on every core release. Worse, the template's own tests travelled
 * with it: every instance CI failure on 2026-07-22 was a template test failing
 * in a repo that had no stake in it and no way to fix it.
 *
 * Exposing them here lets an instance run the guards from the published
 * package, so `cli/` no longer has to be template-owned. The guards are the
 * only part of the CLI an instance invokes from source; everything else
 * (`init`, `deploy`, `core upgrade`, `plugin *`) is already run via
 * `npx @biffo/cli`.
 *
 * Each subcommand is a thin wrapper: the logic stays in `../scripts/`, and the
 * template's own package.json scripts route through here too, so there is one
 * code path rather than two that can drift.
 */
export const checkCommand = new Command('check').description(
  'Repo guards (ownership, release subject, plugin terraform) — run in CI and git hooks',
)

checkCommand
  .command('ownership')
  .description('Refuse changes to template-owned paths in an instance (#370)')
  .argument('[base]', 'Base branch to diff against; defaults to $GITHUB_BASE_REF')
  .option('--staged <messageFile>', 'Check staged changes instead of a branch diff (commit hook)')
  .allowExcessArguments(true)
  .action(async () => {
    // Raw argv, not commander's parsed options: the script has always accepted
    // `--staged <file>` positionally and CI passes a bare base ref. Re-deriving
    // it here would be a second parser to keep in step with that one.
    await runOwnershipCheck(rawArgsAfter('ownership'))
  })

checkCommand
  .command('release-subject')
  .description('Require a Conventional Commits PR title on template-owned changes (#423)')
  .argument('[base]', 'Base branch to diff against; defaults to $GITHUB_BASE_REF')
  .action(async () => {
    await runReleaseSubjectCheck(rawArgsAfter('release-subject'))
  })

checkCommand
  .command('plugin-terraform')
  .description('Verify every template-owned plugin declaring infra ships a Terraform module')
  .action(async () => {
    await runPluginTerraformCheck()
  })

/**
 * Everything on the command line after the named subcommand.
 *
 * `pnpm run <script> -- --staged x` and `npx @biffo/cli check ownership main`
 * have to reach the same parser, and the scripts read their arguments
 * positionally. Slicing argv keeps that contract instead of reconstructing it.
 */
function rawArgsAfter(subcommand: string): string[] {
  const at = process.argv.indexOf(subcommand)
  return at === -1 ? [] : process.argv.slice(at + 1)
}
