import { Command } from 'commander'
import { GitAdapter } from '../adapters/git/index.js'
import { RegistryAdapter } from '../adapters/registry/index.js'
import { checkPluginStaleness, formatStalenessReport } from '../lib/plugin-staleness.js'
import { runAdrNumberingCheck } from '../scripts/check-adr-numbering.js'
import { runBranchProtectionCheck } from '../scripts/check-branch-protection.js'
import { runClaimInvocationCheck } from '../scripts/check-claim-invocation.js'
import { runCodeqlSuppressionCheck } from '../scripts/check-codeql-suppression.js'
import { runCognitoInviteTemplateCheck } from '../scripts/check-cognito-invite-template.js'
import { runCoreDirectPathsCheck } from '../scripts/check-core-direct-paths.js'
import { runOwnershipCheck } from '../scripts/check-core-ownership.js'
import { runDistributionRemoteStateCheck } from '../scripts/check-distribution-remote-state.js'
import { runEventBridgeLogPermissionCheck } from '../scripts/check-eventbridge-log-permissions.js'
import { runInstanceAdoptionCheck } from '../scripts/check-instance-adoption.js'
import { runLambdaOutputCheck } from '../scripts/check-lambda-output.js'
import { runMigrationBodyChangeCheck } from '../scripts/check-migration-body-change.js'
import { runOrphanRatchetCheck } from '../scripts/check-orphan-ratchet.js'
import { runPipeTrapCheck } from '../scripts/check-pipe-trap.js'
import { runPluginAllowlistConventionCheck } from '../scripts/check-plugin-allowlist-convention.js'
import { runPluginCollisionCheck } from '../scripts/check-plugin-collisions.js'
import { runPluginTerraformCheck } from '../scripts/check-plugin-terraform.js'
import { runPluginToolSupplyCheck } from '../scripts/check-plugin-tool-supply.js'
import { runReleaseSubjectCheck } from '../scripts/check-release-subject.js'
import { runSharedFileReductionCheck } from '../scripts/check-shared-file-reduction.js'
import { runSkeletonDriftCheck } from '../scripts/check-skeleton-drift.js'
import { runTerraformInputCheck } from '../scripts/check-terraform-input.js'

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
    'eventbridge-log-permissions, plugin-tool-supply, core-direct-paths, instance-adoption, ' +
    'orphan-ratchet, cognito-invite-template, lambda-output, pipe-trap, codeql-suppression, ' +
    'skeleton-drift, terraform-input, plugin-allowlist-convention, migration-body-change, ' +
    'distribution-remote-state) run in CI and git hooks, plus out-of-band audits (branch ' +
    'protection, plugin-staleness)',
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
  .command('migration-body-change')
  .description(
    "Refuse a PR that changes an already-released migration's HASHED body (DDL, not a " +
      'docstring or comment) with no `# biffo:body-change:` marker (#751) — mirrors ' +
      "migrationBodyHash's normalisation, so a docstring-only edit (#931) stays silent. " +
      'Reporting-only classification, not enforcement: this only requires the marker exist, ' +
      'it does not act on what it declares.',
  )
  .argument('[base]', 'Base branch to diff against; defaults to $GITHUB_BASE_REF')
  .action(async () => {
    await runMigrationBodyChangeCheck(rawArgsAfter('migration-body-change'))
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
  .command('plugin-allowlist-convention')
  .description(
    'Refuse the ADR-0009 service-principal allowlist glob drifting from the IAM role name ' +
      'modules/cloud/aws/compute + modules/plugins/_template actually build (#266) — ' +
      'terraform validate is silent on this because the allowlist never references either ' +
      'naming module by design, so a rename would leave every plugin call rejected with no ' +
      'signal before a real deploy hits it. tabsii-platform#863 is this exact failure shape ' +
      'already reaching production, via a hand-maintained allowlist that simply omitted the ' +
      'plugin host.',
  )
  .action(async () => {
    await runPluginAllowlistConventionCheck()
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
      "skeleton against this repo's own services/api/src; --sibling/--frontend-src plus " +
      "either --estate (resolve the sibling's OWN core from its biffo.sibling.json) or " +
      '--core-src (an explicit override) point it at a real checked-out sibling instead',
  )
  .option('--sibling <name>', 'Label for the report')
  .option('--frontend-src <dir>', "Sibling's frontend source directory to scan")
  .option(
    '--estate <dir>',
    "Directory holding every cloned repo; resolves --sibling's OWN core from its " +
      'biffo.sibling.json core_project field (ignored if --core-src is also given)',
  )
  .option(
    '--core-src <dir>',
    "Core API's source directory (ground truth for route prefixes) — explicit override, " +
      'takes precedence over --estate resolution',
  )
  .action(
    async (opts: { sibling?: string; frontendSrc?: string; coreSrc?: string; estate?: string }) => {
      await runCoreDirectPathsCheck(opts)
    },
  )

checkCommand
  .command('instance-adoption')
  .description(
    'Refuse a real instance tree that has not consumed a registered adoption channel its ' +
      'target template ships (#1538/#1570/#1609) — checkInstanceAdoption previously ran only ' +
      'inside `biffo core upgrade`, so a gap in an instance nobody happened to be upgrading ' +
      'went undetected for days (keiranholloway/biffo-platform, PR #174). --instance-dir is ' +
      'REQUIRED and has no self-check default: this repo is the template, not an instance.',
  )
  .option('--instance <name>', 'Label for the report (defaults to the basename of --instance-dir)')
  .option(
    '--instance-dir <dir>',
    'REQUIRED: the real instance tree to check adoption against (oursDir) — no self-check ' +
      'default exists (exits 2, cannot-tell, when omitted)',
  )
  .option(
    '--theirs-dir <dir>',
    'Template tree that ships the channel (theirsDir); defaults to this repo root',
  )
  .action(async (opts: { instance?: string; instanceDir?: string; theirsDir?: string }) => {
    await runInstanceAdoptionCheck(opts)
  })

checkCommand
  .command('distribution-remote-state')
  .description(
    "Refuse a distribution-inventory.json gapReason restating a REMOTE repo's content as " +
      'current fact once that content has actually changed (#1816) -- fetches every declared ' +
      'remoteContentAssertion via `gh api` and compares against real content, generalising ' +
      'the one-off #1807 wording-regex guard to any entry that declares one. Needs a real ' +
      'cross-repo token (BIFFO_GITHUB_TOKEN in CI); exits 2 (cannot tell) rather than passing ' +
      'when a fetch fails.',
  )
  .action(async () => {
    await runDistributionRemoteStateCheck()
  })

checkCommand
  .command('orphan-ratchet')
  .description(
    'Refuse an instance-written file under a template-owned path with no sanctioned carve-out ' +
      "(#1026), reusing planCoreUpgrade's classify() and checkOrphanRatchet — previously " +
      'reachable only from inside `biffo core upgrade`, so drift was discovered only ~90 core ' +
      'versions later by the upgrade it blocks (#1714). --instance-dir defaults to a SELF-CHECK ' +
      "(this repo's own tree, unlike instance-adoption above) that can only ever report zero — " +
      "see the entrypoint's own doc comment for why that default exists anyway. Pass a real " +
      'instance checkout for a check that can actually find something.',
  )
  .option(
    '--instance-dir <dir>',
    "The real instance tree to check (oursDir). Defaults to a self-check of this repo's own " +
      'root, which always reports 0 orphans (#1714) — pass a real instance checkout for a ' +
      'meaningful result',
  )
  .option(
    '--theirs-dir <dir>',
    'Template tree that defines ownership (theirsDir); defaults to this repo root',
  )
  .option(
    '--base-dir <dir>',
    "Merge-base template tree (baseDir) — the template at the instance's CURRENT core " +
      'version; defaults to --theirs-dir, which is only correct when the instance is already ' +
      'on the latest version',
  )
  .option('--label <name>', 'Label for the report; defaults to the basename of --instance-dir')
  .action(
    async (opts: {
      instanceDir?: string
      theirsDir?: string
      baseDir?: string
      label?: string
    }) => {
      await runOrphanRatchetCheck(opts)
    },
  )

checkCommand
  .command('cognito-invite-template')
  .description(
    'Refuse a Cognito invite_message_template missing a required member or placeholder ' +
      '(#356) — terraform validate is silent on this, so a fresh deploy fails on its first apply',
  )
  .action(async () => {
    await runCognitoInviteTemplateCheck()
  })

checkCommand
  .command('lambda-output')
  .description(
    'Refuse an unsuppressed aws lambda update-function-* call (#334) — its default output is ' +
      'the full function configuration, env vars in plaintext, leaked into the Actions log',
  )
  .action(async () => {
    await runLambdaOutputCheck()
  })

checkCommand
  .command('pipe-trap')
  .description(
    'Refuse a status-bearing command (claim.sh, wait-for-checks, git push, ...) piped into ' +
      "another, or $? read after one (#1231) — both read the LAST command's exit status",
  )
  .action(async () => {
    await runPipeTrapCheck()
  })

checkCommand
  .command('codeql-suppression')
  .description(
    'Refuse a `// codeql[query-id]` comment anywhere in cli/src (#1491) — it does not ' +
      "suppress anything in this repo's CodeQL setup; alert #21 stayed open under one",
  )
  .action(async () => {
    await runCodeqlSuppressionCheck()
  })

checkCommand
  .command('claim-invocation')
  .description(
    'Refuse a distributed AGENTS.md that documents a different claim invocation from the ' +
      'others, or an untokened `claim <issue>` (#1562) — `--as` reached one of three copies, ' +
      'so it was documented in zero satellites while working perfectly',
  )
  .action(async () => {
    await runClaimInvocationCheck()
  })

checkCommand
  .command('skeleton-drift')
  .description(
    'Refuse a fix this repo made for itself that never reached _skeletons/ — a hardcoded ' +
      'runner, the paid gitleaks action, an unhardened dependency audit, a hard-coded app title',
  )
  .action(async () => {
    await runSkeletonDriftCheck()
  })

checkCommand
  .command('terraform-input')
  .description(
    'Refuse a Terraform invocation that can prompt on stdin without -input=false, or a ' +
      'workflow running Terraform without TF_INPUT set (#322) — a runner has no stdin to answer',
  )
  .action(async () => {
    await runTerraformInputCheck()
  })

checkCommand
  .command('shared-file-reduction')
  .description(
    'Refuse a shared-files.json overwrite that would DELETE tests from the satellite it lands ' +
      'in (#1577) — filesIfPresent is a one-way cp and nothing ever compared the two copies. ' +
      'Invoked by scripts/shared-sync.sh at the moment of the write, not by per-PR CI: both ' +
      'sides of the comparison only exist together inside a sync run. Compares TEST TITLES in ' +
      'TS/JS test files and nothing else — see the guard module for what it does not catch.',
  )
  .option('--pairs <tsv>', 'TSV of target<TAB>existing<TAB>incoming lines, or - for stdin')
  .option('--target <path>', 'Single pair: path inside the satellite')
  .option('--existing <path>', "Single pair: the satellite's current copy")
  .option('--incoming <path>', 'Single pair: the canonical copy that would replace it')
  .option('--manifest <path>', 'shared-files.json, read for acceptedReductions')
  .action(
    async (opts: {
      pairs?: string
      target?: string
      existing?: string
      incoming?: string
      manifest?: string
    }) => {
      await runSharedFileReductionCheck(opts)
    },
  )

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

checkCommand
  .command('plugin-staleness')
  .description(
    'Advisory: report how far each services/<name>/ vendored plugin has drifted from its ' +
      'source (#1547) — an instance can drift arbitrarily far behind a plugin repo while both ' +
      "sides' CI stays green, because neither has an opinion about the gap between them. " +
      'Deliberately NEVER fails this check, unlike every other one in this group: an instance ' +
      'may legitimately pin a plugin version, and staleness moving is not a defect the way an ' +
      'ownership violation or a namespace collision is. Run `biffo plugin staleness` directly ' +
      'for the same measurement with a real 0/1/2 exit code, if you want to gate on it.',
  )
  .action(async () => {
    const cwd = process.env['BIFFO_ORIGINAL_CWD'] || process.cwd()
    const results = await checkPluginStaleness(cwd, {
      registry: new RegistryAdapter(),
      git: new GitAdapter(),
    })
    console.log(formatStalenessReport(results))
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
