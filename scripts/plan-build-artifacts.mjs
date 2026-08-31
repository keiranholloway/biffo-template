/**
 * Find every plan-time-generated file a Terraform plan actually referenced
 * (issue #1663 general case, biffo-template#1772).
 *
 * ## Why this exists
 *
 * `deploy-infra.yml` runs `plan` and `apply` as separate jobs on separate
 * runners, so any file a `data "archive_file"` data source writes to disk
 * during `terraform plan` (its `output_path`) does not exist on the apply
 * runner unless something explicitly transports it (#1457, #1663).
 *
 * The first fix for #1663 uploaded/downloaded one hardcoded directory,
 * `infra/environments/<env>/.build/`, alongside `tfplan`. That is this
 * repo's OWN historical convention for where an environment-root
 * `archive_file` lands, but it is an assumed location, not a computed one --
 * an `archive_file` declared inside a REUSABLE MODULE with
 * `output_path = "${path.module}/build/..."` (this repo's own former
 * `modules/cloud/aws/compute/main.tf`, before #1457/#1460 replaced it with a
 * committed placeholder) writes OUTSIDE `.build/` entirely, and the
 * hardcoded-directory fix does not see it. #1772 reproduces that exact shape
 * against the fixed workflow and gets the identical "no such file or
 * directory" `terraform apply` failure #1663 was filed to prevent.
 *
 * This module computes the file set from the plan itself instead: every
 * `archive_file` data source's resolved `output_path`, wherever in the tree
 * it lands, becomes one entry to transport. Nothing about the location is
 * assumed.
 *
 * ## Where `output_path` actually lives in `terraform show -json`
 *
 * An `archive_file` data source with no unresolved dependencies is evaluated
 * during the plan's initial refresh, before the graph walk that produces
 * `resource_changes` -- confirmed against a real `terraform show -json`
 * (terraform 1.9.8, `hashicorp/archive` ~> 2.4) built from a fixture
 * reproducing #1772's own repro: it appears fully resolved in
 * `prior_state.values.root_module` (and recursively under `child_modules`),
 * and does NOT appear in `resource_changes` at all -- there is no "change"
 * to report for a data source whose reading was identical to how it will be
 * read again. `planned_values.root_module` was checked too and does not
 * carry it either, in that same fixture.
 *
 * A data source whose `output_path` depends on a value not yet known at plan
 * time (e.g. an attribute of a resource not yet created) IS deferred to
 * apply, and then it does appear in `resource_changes` with
 * `actions: ["read"]` and `after_unknown.output_path: true` -- and, being
 * unresolved, nothing has been written to disk for it at plan time, so there
 * is nothing to transport for that case; the apply job produces it itself.
 *
 * Given none of that is documented as a stable contract, this walks all
 * three places (`prior_state`, `planned_values`, `resource_changes`) and
 * merges what each finds, deduplicated -- cheap, and it means a future
 * Terraform version resolving a data source into a different section of the
 * JSON doesn't silently stop being seen.
 */

/** Recursively collect every `data "archive_file"` resource's `output_path` from a `values.root_module`-shaped subtree (present in both `prior_state.values` and `planned_values`). */
function walkModuleForArchiveFilePaths(module, out) {
  if (!module || typeof module !== 'object') return
  for (const resource of module.resources || []) {
    if (resource.mode === 'data' && resource.type === 'archive_file') {
      const outputPath = resource.values && resource.values.output_path
      if (typeof outputPath === 'string' && outputPath.length > 0) out.add(outputPath)
    }
  }
  for (const child of module.child_modules || []) {
    walkModuleForArchiveFilePaths(child, out)
  }
}

/**
 * Every `output_path` an `archive_file` data source in this plan resolved to,
 * deduplicated. Does not touch disk -- callers decide what to do with a path
 * that doesn't exist (see `collect-plan-build-artifacts.mjs`).
 */
export function extractArchiveFileOutputPaths(plan) {
  const out = new Set()

  walkModuleForArchiveFilePaths(plan && plan.prior_state && plan.prior_state.values && plan.prior_state.values.root_module, out)
  walkModuleForArchiveFilePaths(plan && plan.planned_values && plan.planned_values.root_module, out)

  for (const change of (plan && plan.resource_changes) || []) {
    if (change.mode !== 'data' || change.type !== 'archive_file') continue
    const after = change.change && change.change.after
    const outputPath = after && after.output_path
    if (typeof outputPath === 'string' && outputPath.length > 0) out.add(outputPath)
  }

  return [...out]
}
