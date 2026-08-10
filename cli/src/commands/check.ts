import { Command } from 'commander'
import { runAdrNumberingCheck } from '../scripts/check-adr-numbering.js'
import { runBranchProtectionCheck } from '../scripts/check-branch-protection.js'
import { runCoreDirectPathsCheck } from '../scripts/check-core-direct-paths.js'
import { runOwnershipCheck } from '../scripts/check-core-ownership.js'
import { runEventBridgeLogPermissionCheck } from '../scripts/check-eventbridge-log-permissions.js'
import { runPluginCollisionCheck } from '../scripts/check-plugin-collisions.js'
import { runPluginTerraformCheck } from '../scripts/check-plugin-terraform.js'
import { runPluginToolSupplyCheck } from '../scripts/check-plugin-tool-supply.js'
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
  'Repo guards (ownership, release subject, plugin terraform, plugin collisions, ' +
    'eventbridge-log-permissions, plugin-tool-supply, core-direct-paths) run in CI and git ' +
    'hooks, plus out-of-band audits (branch protection)',
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
  .command('plugin-collisions')
  .description('Refuse two vendored plugins claiming the same importable name (#688)')
  .action(async () => {
    await runPluginCollisionCheck()
  })

checkCommand
  .command('plugin-terraform')
  .description('Verify every template-owned plugin declaring infra ships a Terraform module')
  .action(async () => {
    await runPluginTerraformCheck()
  })

checkCommand
  .command('adr-numbering')
  .description(
    "Refuse two ADRs in this repo's own docs/ADR/ claiming the same number (tabsii-platform#449)",
  )
  .action(async () => {
    await runAdrNumberingCheck()
  })

checkCommand
  .command('eventbridge-log-permissions')
  .description(
    'Refuse an EventBridge target writing to a CloudWatch Logs group no resource policy ' +
      'grants it access to (#1356) — terraform apply succeeds and the rule reports ENABLED ' +
      'on the broken shape, so this is the only signal available before either exists',
  )
  .action(async () => {
    await runEventBridgeLogPermissionCheck()
  })

checkCommand
  .command('plugin-tool-supply')
  .description(
    'Refuse a plugin manifest declaring a tool whose is_available predicate reads an env ' +
      'var no Terraform environment_variables block ever wires (#822) — the shape that left ' +
      'web_search silently unavailable in every environment, forever',
  )
  .action(async () => {
    await runPluginToolSupplyCheck()
  })

checkCommand
  .command('core-direct-paths')
  .description(
    "Refuse a frontend's core-direct call site (bypassing its own BFF) naming a route " +
      'prefix core does not register (#1377). Defaults to a self-check of the sibling ' +
      "skeleton against this repo's own services/api/src; --sibling/--frontend-src/--core-src " +
      'point it at a real checked-out sibling instead',
  )
  .option('--sibling <name>', 'Label for the report')
  .option('--frontend-src <dir>', "Sibling's frontend source directory to scan")
  .option('--core-src <dir>', "Core API's source directory (ground truth for route prefixes)")
  .action(async (opts: { sibling?: string; frontendSrc?: string; coreSrc?: string }) => {
    await runCoreDirectPathsCheck(opts)
  })

checkCommand
  .command('branch-protection')
  .description(
    'Verify dev/staging/main are actually protected — scaffolding skips this on a 403 (#715)',
  )
  .option('--repo <owner/name>', "Repo to audit; defaults to this checkout's origin remote")
  .option(
    '--fix',
    'Backfill protection from the checks this repo actually reports (#714, #715). ' +
      'Refuses to apply an empty required-check list, which would look protected and admit anything.',
  )
  .action(async (opts: { repo?: string; fix?: boolean }) => {
    await runBranchProtectionCheck(opts.repo, { fix: opts.fix })
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
