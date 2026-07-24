# ADR-0009 — the service-principal allowlist for /api/v1/internal/*.
#
# This module owns ONE thing: turning the list of enabled plugin names into the
# list of IAM principal ARNs the Core API will accept on its internal routes.
# It exists as a module, rather than as a `locals` block in each root config,
# because the glob it builds encodes a convention owned by two OTHER
# template-owned modules:
#
#   modules/cloud/aws/compute       names every function's IAM role
#                                   "<project>-<env>-<function>-role"
#   modules/plugins/_template       names the plugin's function
#                                   "plugin-<name>"
#
#   => role name: "<project>-<env>-plugin-<name>-role"
#
# Those modules ride `biffo core upgrade` into every instance. Before #266 the
# glob did not: it lived in infra/environments/*/main.tf, which is user-owned,
# so a rename in either module would have updated every instance while the
# allowlist stayed behind — silently, per-instance, on the IAM path that gates
# the internal routes. Keeping the derivation next to the convention it depends
# on is the point of this module. The drift guard in
# cli/src/lib/plugin-allowlist-convention.ts fails the build if the two ever
# disagree.
#
# ---------------------------------------------------------------------------
# Why the input is `enabled_plugins` (names) and NEVER a plugin module's
# `role_arn` output
# ---------------------------------------------------------------------------
#
# See ADR-0009's amendment history (2026-07-19), which corrected an earlier,
# overstated rationale. Reading `role_arn` does NOT deadlock on the current
# module shape — that was tested, and it plans fine. Terraform's graph is
# resource-level, and _template's `aws_iam_role` does not itself depend on API
# Gateway; only its separate `aws_iam_role_policy.core_api` does. So the honest
# reasons to reject it are:
#
#   1. That "it happens to plan" is an accident of one module's internals, not
#      a guarantee. A plugin that attaches its Core API policy INLINE on the
#      role closes a genuine cycle — core_api -> api_gateway -> plugin ->
#      core_api — and the error surfaces for whoever installed that plugin.
#   2. It would make the Core API un-plannable whenever ANY installed plugin
#      module is broken. The Core API must not be hostage to third-party
#      Terraform.
#
# A name-derived glob has no dependency on any plugin module at all, for any
# plugin. That is the property worth keeping.
#
# ---------------------------------------------------------------------------
# Fail-closed
# ---------------------------------------------------------------------------
#
# With no plugins enabled this output is [], and `require_service_principal`
# accepts no service caller at all. Enabling a plugin (which `biffo plugin
# install` does via a generated plugins.auto.tfvars.json) is what allowlists
# it, so the execute-api grant and the allowlist cannot drift apart. Do not
# introduce a wildcard "allow all" branch here: an empty list must stay empty.

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

# The account the roles live in. Owned here so root configs do not have to
# declare a data source purely to feed this glob.
data "aws_caller_identity" "current" {}

locals {
  # The trailing /* matches the session name STS appends to an assumed-role ARN.
  service_principal_arns = [
    for name in var.enabled_plugins :
    "arn:aws:sts::${data.aws_caller_identity.current.account_id}:assumed-role/${var.project_name}-${var.environment}-plugin-${name}-role/*"
  ]

  # First-party plugins (ADR-0014) are core capability, provisioned by the
  # template-owned infra/environments/<env>/plugins.core.tf and always
  # allowlisted here — with no edit to the user-owned root config that calls this
  # module, so a fresh instance's agents can reach the internal API out of the
  # box. Same glob as above (the drift guard checks that one loop); listing a
  # core plugin an instance has disabled is harmless, since its role ARN then
  # matches no principal.
  core_service_principal_arns = [
    for name in var.core_plugins :
    "arn:aws:sts::${data.aws_caller_identity.current.account_id}:assumed-role/${var.project_name}-${var.environment}-plugin-${name}-role/*"
  ]

  # The shared plugin host (ADR-0021) — one always-present Lambda that runs every
  # user-facing plugin's API and calls Core's internal routes on their behalf,
  # asserting each plugin's identity (ADR-0021 §1a). Its role follows the same
  # compute-module convention (function_name "plugin-host" => role
  # "<project>-<env>-plugin-host-role"), so the same glob applies. Listed
  # unconditionally, like the core plugins, and harmless where no host is deployed
  # (the ARN then matches no principal). It is deliberately NOT in core_plugins:
  # that list is paired 1:1 with plugins.core.tf's `plugin_name` module blocks by
  # the core-plugins-sync guard, and the host is infrastructure, not a first-party
  # plugin — it has no such block.
  host_service_principal_arn = "arn:aws:sts::${data.aws_caller_identity.current.account_id}:assumed-role/${var.project_name}-${var.environment}-plugin-host-role/*"

  all_service_principal_arns = distinct(concat(
    local.core_service_principal_arns,
    local.service_principal_arns,
    [local.host_service_principal_arn],
  ))
}
