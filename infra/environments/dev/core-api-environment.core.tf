# The Core API's environment — TEMPLATE-OWNED (biffo-template#1538, #1540).
#
# A carve-out inside the otherwise user-owned infra/environments/ tree, the same
# pattern as plugins.core.tf, plugin-host.core.tf, pr-signer.core.tf and
# plugin-storage.core.tf. It rides `biffo core upgrade`.
#
# ## The gap this closes
#
# `module "core_api"` is declared in infra/environments/dev/main.tf, which is
# USER-OWNED, and its `environment_variables` is a LITERAL MAP inside that
# block. Terraform has no mechanism for a second file to add an argument to a
# module block another file declared — arguments are not additive across files,
# and `_override.tf` replaces a whole argument rather than merging into it. So
# no template-owned file could ever carry a new environment variable into an
# instance's Core API. Not "was not carrying one": could not.
#
# Two live casualties, and neither is theoretical:
#
#   * BIFFO_PLUGIN_MEDIA_BUCKET (#1538). plugin-storage.core.tf distributes the
#     IAM grant, so every instance's Core role can sign for `plugins/*` — but
#     the bucket NAME only ever existed on a hand-written line in this repo's
#     own main.tf. Confirmed absent from the live `tabsii-platform-dev-core-api`
#     Lambda's configuration: `api.plugin_storage._bucket()` therefore raises
#     ObjectStorageUnavailableError, and plugin object storage has never worked
#     in any instance, anywhere. The half that distributed made the half that
#     did not invisible — the grant is present, so nothing looks missing.
#   * BIFFO_PR_SIGNER_FUNCTION_NAME (#1540). Same file, same block, same
#     non-distribution. pr-signer.core.tf's own header already admitted it:
#     "that direction of reference could not move here without editing
#     module.core_api's own block, which is outside this carve-out's scope".
#     That sentence described the constraint accurately and left it in place.
#
# ## The mechanism — the one module "plugin_host" already has
#
# plugin-host.core.tf reads `merge(var.plugin_host_environment, { ... })`
# (#1534, live on tabsii carrying MARKETING_IMAGE_PROVIDER_API_KEY_PARAMETER).
# The module block consumes a merge whose first argument is declared in a
# template-owned file, so the template gains somewhere to put a key that is not
# the module block itself.
#
# main.tf's side of it is ONE line — the opening of the existing map:
#
#     environment_variables = merge(local.core_api_environment, {
#       BIFFO_ENVIRONMENT = local.environment
#       ...unchanged...
#     })
#
# ## Why a `local` here and a bare `var` in plugin-host.core.tf
#
# Not a style difference: a root-module variable's `default` may only be a
# constant expression. It cannot reference `module.storage` or
# `module.pr_signer`, which is exactly what both casualties are — values
# computed from other Terraform resources. A variable ALONE can therefore never
# carry them, no matter which file declares it, because there is no
# template-owned place to write the value: `.auto.tfvars` files take constants
# too.
#
# plugin_host does not hit this because ITS literal map already lives in a
# template-owned file, so its core keys have somewhere to be. core_api's literal
# is user-owned, so the core keys move HERE, into `local.core_api_environment`,
# and `var.core_api_environment` keeps the job the plugin-host variable has:
# carrying per-instance configuration. The instance-side change is a single line
# either way, and the ordering rule below is identical.
#
# ## Precedence: caller-supplied map FIRST, core keys SECOND
#
# Quoted from plugin-host.core.tf, which set this rule:
#
#     # `plugin_host_environment` first so a core key can never be silently
#     # overridden by instance config — a plugin shadowing BIFFO_CORE_API_URL
#     # would break every plugin on the host, not just its own.
#
# Same ordering here, for the same reason. An instance that sets
# BIFFO_PLUGIN_MEDIA_BUCKET in `core_api_environment` does not get to point
# Core's object storage at a bucket plugin-storage.core.tf's IAM grant does not
# cover — that would produce presigned URLs that are perfectly well-formed and
# AccessDenied in the browser, which is the failure shape that capability has
# already paid for once.
#
# ## What this does NOT solve
#
# Only environment variables. A future template change needing a different
# module ARGUMENT on module.core_api — a timeout, a new secret ARN, another
# grant expressed as a module input — still has no channel, for the same reason
# stated at the top. Fixing the general case means moving `module "core_api"`
# wholesale into a template-owned .core.tf file (option 2 in #1538), which is a
# separate, deliberately-deferred decision. This is the specific case, not the
# class.
#
# `services/api/tests/test_core_api_environment_distribution.py` guards this
# file: it reads the env-var names Core's own Settings fields resolve to and
# asserts each is supplied here, with `var.core_api_environment` positioned
# first in the merge.
locals {
  # Core keys — supplied by the template, not by the instance. Everything in
  # this map is computed from another Terraform resource, which is precisely
  # why it cannot live in `var.core_api_environment`'s default (see above).
  core_api_environment = merge(var.core_api_environment, {
    # Plugin object storage (ADR-0021, #1437, distributed by #1538). Bucket name
    # rather than ARN: every boto3 call takes a bucket name, and deriving one
    # from the other in code is a second place to get it wrong. Matches the key
    # plugin-host.core.tf sets on the shared host — the two Lambdas both hold
    # `api.plugin_storage` and both need telling which bucket.
    #
    # Empty is a valid state — Core treats it as "object storage not configured"
    # and refuses the capability with a clear error rather than signing URLs
    # against a bucket that is not there.
    BIFFO_PLUGIN_MEDIA_BUCKET = module.storage.plugin_media_bucket_name

    # Name of the PR-signer Lambda to invoke for endpoint permission changes
    # (ADR-0008, distributed by #1540). Empty when the signer isn't provisioned;
    # the Core API treats an empty value as "endpoint control plane not
    # configured". Core cannot derive this by convention the way it derives the
    # agent-runtime's name, because the signer is conditionally provisioned per
    # `var.enable_pr_signer` and Core needs to tell "not configured" apart from
    # a live function name.
    #
    # `module.pr_signer` is declared in pr-signer.core.tf; Terraform resolves a
    # module by name regardless of which file in this directory declares it, so
    # the cross-file reference is unremarkable — the same shape that file already
    # uses for module.auth/module.events/module.api_gateway.
    BIFFO_PR_SIGNER_FUNCTION_NAME = var.enable_pr_signer ? module.pr_signer[0].function_name : ""
  })
}

variable "core_api_environment" {
  description = <<-EOT
    Extra environment variables for the Core API Lambda.

    The counterpart to `plugin_host_environment` (ADR-0021), for the other half
    of the runtime. An instance — or a plugin whose code runs INSIDE Core rather
    than on the shared host — that needs configuration has nowhere else to be
    told about it: `module "core_api"` is declared in the user-owned main.tf, so
    before this variable the only way to add a key was to hand-edit that file in
    every instance, and no template-owned change could ever reach it.

    Secrets belong here by PARAMETER NAME, never by value: pass
    `<THING>_..._PARAMETER = "/project/env/thing"` and grant the Core API's role
    `ssm:GetParameter` on that exact path. Putting a secret's value in a Lambda
    environment variable puts it in every `get-function-configuration` response
    and in Terraform state.

    Two limits worth knowing, the same two `plugin_host_environment` carries.
    This map is FLAT and the Core API is SHARED, so names are
    first-come-first-served across everything running in that Lambda and any
    code in it can read any other's values — prefix per consumer, and do not put
    one tenant's secret here expecting isolation. And nothing checks that a
    declared need was actually supplied; unconfigured code still deploys and
    fails at request time. Making the declaration machine-checked at install is
    tracked in #1517.

    A key set here NEVER overrides a core key: `local.core_api_environment`
    merges this map first and the template's own keys second, deliberately.
  EOT
  type        = map(string)
  default     = {}
}
