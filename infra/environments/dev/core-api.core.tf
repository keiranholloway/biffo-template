# The Core API Lambda — TEMPLATE-OWNED (biffo-template#1538 option 2).
#
# A carve-out inside the otherwise user-owned infra/environments/ tree, the same
# pattern as plugins.core.tf, plugin-host.core.tf, pr-signer.core.tf,
# plugin-storage.core.tf and core-api-environment.core.tf. It rides
# `biffo core upgrade`.
#
# `module "core_api"` used to be declared in the user-owned main.tf. Terraform
# cannot add an argument to a module block from a second file, so ANY argument
# (not only environment_variables) that a template change needed to alter had
# no channel short of a hand-edit in every instance. Declaring the whole block
# here makes every argument template-owned. `invoke_function_arns` moved with
# it. `local.core_api_environment` (core-api-environment.core.tf) is still the
# home of the core environment keys and is merged in below unchanged.
#
# Terraform resolves references by name across every file in the directory, so
# module.networking / module.database / module.auth / module.events /
# aws_kms_key.logs (user-owned main.tf) and module.pr_signer (pr-signer.core.tf)
# are referenced here the same way pr-signer.core.tf already does.
#
# ## Adoption in existing instances
#
# A resource's address (`module.core_api`) does not include the file that
# declares it, so moving the block between files is a no-op to Terraform's state:
# no `moved` block is needed (and one from an address to itself is an error), and
# the live Lambda is not destroyed or recreated. What an instance MUST do on its
# next `biffo core upgrade` is DELETE its own `module "core_api"` block from
# infra/environments/dev/main.tf — otherwise Terraform fails with `Duplicate
# module call`. Any instance-specific arguments in that block must be re-homed
# (environment via `core_api_environment`) before deleting. `biffo core upgrade`
# reports this via the `core-api-module` pair in cli/src/lib/instance-adoption.ts.

module "core_api" {
  source = "../../../modules/cloud/aws/compute"

  project_name          = var.project_name
  environment           = local.environment
  function_name         = "core-api"
  handler               = "src.api.main.lambda_handler"
  cloudwatch_kms_key_id = aws_kms_key.logs.arn
  # Bumped from the compute module's 30s default: a DDL import batch
  # (biffo:ddl-import, ADR-0005) runs one or more .sql files on a single
  # connection and is expected to comfortably finish well under this, but a
  # file expected to run longer than this is explicitly out of scope for v1
  # (split it or apply manually) rather than raised further.
  timeout                   = 300
  enable_vpc_access         = true
  vpc_id                    = module.networking.vpc_id
  private_subnet_ids        = module.networking.private_subnet_ids
  db_credentials_secret_arn = module.database.credentials_secret_arn
  # Least-privilege application role (#253). Granted for IAM completeness; this
  # NAT-less environment reaches Secrets Manager only via the interface VPC
  # endpoint, and the URL is baked in below regardless.
  app_db_credentials_secret_arn = module.database.app_credentials_secret_arn
  event_bus_name                = module.events.event_bus_name
  # Lets the Core API administer Cognito users (add/assign-group/suspend/remove).
  # Runtime reachability is provided by the cognito-idp interface VPC endpoint
  # the networking module creates in this NAT-less environment.
  cognito_user_pool_arn = module.auth.user_pool_arn
  # Lets the Core API invoke, over IAM, the isolated PR-signer (ADR-0008; the
  # signer, not the Core API, holds the GitHub App credential). Present only when
  # the signer is provisioned. module.pr_signer itself is now defined in the
  # template-owned pr-signer.core.tf (#568), and so is module.core_api together
  # with this argument: this whole file is template-owned. Terraform resolves
  # module.pr_signer by name regardless of which file in this directory declares
  # it, so the cross-file reference is unremarkable.
  #
  # BIFFO_PR_SIGNER_FUNCTION_NAME is not set here: #1540 moved it to the
  # template-owned core-api-environment.core.tf. `invoke_function_arns` is a
  # module ARGUMENT, not an environment variable, so it is set directly on this
  # block rather than through that file's local.core_api_environment map.
  #
  # The Core -> agent-runtime sync-invoke grant (ADR-0016) is deliberately NOT
  # here: it lives in the template-owned plugins.core.tf as a standalone
  # aws_iam_role_policy on this role. Core derives the runtime's
  # function name by convention (services/api config.py), not from an env var set
  # here. pr-signer can't follow that same convention-only shape: it is
  # conditionally provisioned per `var.enable_pr_signer`, so Core needs this env
  # var to tell "not configured" apart from a live function name.
  invoke_function_arns = var.enable_pr_signer ? [module.pr_signer[0].function_arn] : []
  # `local.core_api_environment` is declared in the TEMPLATE-OWNED
  # core-api-environment.core.tf (#1538, #1540) and is the only channel a
  # template change has into this Lambda's environment: this map is a literal
  # inside a module block in a user-owned file, and Terraform cannot add an
  # argument to it from another file. BIFFO_PLUGIN_MEDIA_BUCKET and
  # BIFFO_PR_SIGNER_FUNCTION_NAME are supplied there for exactly that reason and
  # are deliberately no longer listed below. Keys in this literal still win over
  # that map, so nothing an instance already sets here changes behaviour.
  environment_variables = merge(local.core_api_environment, {
    BIFFO_ENVIRONMENT = local.environment
    # Full DB URLs baked in — Lambda has no outbound internet so it can't call
    # Secrets Manager. Both are sensitive and stored in Terraform state.
    #
    # BIFFO_DATABASE_URL is the MASTER/owner credential: migrations,
    # biffo:db-init and biffo:ddl-import connect with it because they create
    # and alter objects. BIFFO_APP_DATABASE_URL is the non-owner biffo_app role
    # the HTTP request path connects with instead (#253) — db-init creates that
    # role in Postgres and grants it, since Terraform has no DB connection.
    BIFFO_DATABASE_URL         = module.database.db_url
    BIFFO_APP_DATABASE_URL     = module.database.app_db_url
    BIFFO_APP_ROLE_NAME        = module.database.app_db_user
    BIFFO_COGNITO_JWKS_JSON    = data.http.cognito_jwks.response_body
    BIFFO_COGNITO_USER_POOL_ID = module.auth.user_pool_id
    BIFFO_COGNITO_CLIENT_ID    = module.auth.client_id
    BIFFO_COGNITO_REGION       = var.aws_region
    BIFFO_EVENT_BUS_NAME       = module.events.event_bus_name
    BIFFO_CORS_ORIGINS         = local.cors_origins
    # ADR-0009 — IAM principals allowed on /api/v1/internal/*. Maintained
    # automatically: `biffo plugin install` adds the plugin to enabled_plugins
    # (plugins.auto.tfvars.json) and the glob above follows. Fails closed when
    # no plugin is enabled.
    BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST = jsonencode(module.plugin_allowlist.arns)
    # Set so discover_plugin_manifests() finds bundled plugin manifests at
    # runtime — deploy-app.yml's packaging step copies services/*/biffo.plugin.json
    # into the Lambda zip under services/, which AWS extracts to /var/task/.
    BIFFO_PLUGIN_SERVICES_ROOT = "/var/task/services"
    # Set so discover_ddl_import_dirs() finds bundled DDL imports at runtime —
    # deploy-app.yml's packaging step copies db/imports/<name>/*.sql into the
    # Lambda zip under db/imports/, which AWS extracts to /var/task/ (ADR-0005).
    BIFFO_DDL_IMPORT_ROOT = "/var/task/db/imports"
  })
  tags = local.tags
}
