terraform {
  required_version = ">= 1.9"

  required_providers {
    aws  = { source = "hashicorp/aws", version = "~> 5.0" }
    http = { source = "hashicorp/http", version = "~> 3.0" }
  }

  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = "dev"
      ManagedBy   = "terraform"
    }
  }
}

locals {
  environment = "dev"
  tags = {
    Project     = var.project_name
    Environment = local.environment
  }
  custom_domain_enabled = var.custom_domain != "" && var.acm_certificate_arn != ""
  portal_url            = local.custom_domain_enabled ? "https://${var.custom_domain}" : "https://${module.cdn.distribution_domain}"
  cors_origins_list = concat(
    local.custom_domain_enabled ? ["https://${var.custom_domain}"] : [],
    ["https://${module.cdn.distribution_domain}", "http://localhost:3000"],
  )
  cors_origins = jsonencode(local.cors_origins_list)
}

# ---------------------------------------------------------------------------
# Shared CloudWatch Logs CMK (#445)
#
# One customer-managed key encrypts every CloudWatch Log group in this
# environment, instead of each compute/events/api-gateway module
# self-provisioning its own. Consolidates dev from 6 CMKs to 3 (this shared key
# plus the two plugins, which deliberately keep self-provisioning — see
# plugins.core.tf, which must not depend on this user-owned resource). Zero
# security-posture change: log encryption stays customer-managed. Wired into the
# modules below via cloudwatch_kms_key_id.
# ---------------------------------------------------------------------------
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

resource "aws_kms_key" "logs" {
  description             = "Shared CMK for ${var.project_name} ${local.environment} CloudWatch logs"
  enable_key_rotation     = true
  deletion_window_in_days = 7
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "EnableRoot", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }, Action = "kms:*", Resource = "*" },
      { Sid = "AllowCloudWatchLogs", Effect = "Allow", Principal = { Service = "logs.${data.aws_region.current.name}.amazonaws.com" }, Action = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"], Resource = "*", Condition = { ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:*" } } }
    ]
  })
  tags = local.tags
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${var.project_name}-${local.environment}-logs"
  target_key_id = aws_kms_key.logs.key_id
}

# ADR-0009 — which IAM principals may call /api/v1/internal/* on the Core API.
#
# The glob format, the aws_caller_identity lookup and the fail-closed empty-list
# behaviour all live in the module. That is deliberate: the glob encodes a
# convention owned by modules/cloud/aws/compute (every function's role is
# "<project>-<env>-<function>-role") and modules/plugins/_template (a plugin's
# function is "plugin-<name>"). Those are template-owned and ride `biffo core
# upgrade`; this file is user-owned and does not. Keeping the derivation beside
# the convention is what stops a rename in either module from updating every
# instance while the allowlist silently stays behind. Keep this block thin —
# a module call plus the one line on module.core_api below.
#
# The input is plugin NAMES, never a plugin module's role_arn output. Per
# ADR-0009's 2026-07-19 amendment, the reason is NOT that role_arn deadlocks:
# that wording was overstated and was corrected after testing — it plans fine on
# today's module shape, because Terraform's graph is resource-level and
# _template's aws_iam_role does not itself depend on API Gateway. The real
# reasons are that this is an accident of one module's internals (a plugin
# attaching its Core API policy inline on the role closes a genuine
# core_api -> api_gateway -> plugin -> core_api cycle), and that depending on a
# plugin module would make the Core API un-plannable whenever any installed
# plugin module is broken.
module "plugin_allowlist" {
  source = "../../../modules/cloud/aws/plugin-allowlist"

  project_name    = var.project_name
  environment     = local.environment
  enabled_plugins = var.enabled_plugins
}

module "networking" {
  source = "../../../modules/cloud/aws/networking"

  project_name = var.project_name
  environment  = local.environment
  # dev egress via a cheap fck-nat NAT instance (~$3-5/mo), not billed interface
  # VPC endpoints (~$70/mo once ≥3 services need one) or a managed NAT gateway
  # (~$35/mo). The instance also routes to the Lambda control-plane API, which the
  # in-VPC Core needs to invoke the agent-runtime (ADR-0016/0019). enable_nat_gateway
  # stays false — the two are mutually exclusive.
  enable_nat_gateway  = false
  enable_nat_instance = true
  single_nat_gateway  = true # irrelevant unless enable_nat_gateway = true; kept for explicitness
  tags                = local.tags
}

moved {
  from = module.storage.aws_s3_bucket_policy.portal
  to   = module.cdn.aws_s3_bucket_policy.portal
}

module "storage" {
  source = "../../../modules/cloud/aws/storage"

  project_name = var.project_name
  environment  = local.environment
  tags         = local.tags
}

module "cdn" {
  source = "../../../modules/cloud/aws/cdn"

  project_name                  = var.project_name
  environment                   = local.environment
  portal_bucket_regional_domain = module.storage.portal_bucket_regional_domain
  portal_bucket_name            = module.storage.portal_bucket_name
  portal_bucket_id              = module.storage.portal_bucket_name
  portal_bucket_arn             = module.storage.portal_bucket_arn
  custom_domain                 = var.custom_domain
  acm_certificate_arn           = var.acm_certificate_arn
  hosted_zone_id                = var.hosted_zone_id
  sibling_origins               = var.sibling_origins
  plugin_api_origins            = var.plugin_api_origins
  tags                          = local.tags
}

module "auth" {
  source = "../../../modules/cloud/aws/auth"

  project_name      = var.project_name
  environment       = local.environment
  domain_prefix     = "${var.project_name}-dev"
  admin_email       = var.admin_email
  admin_username    = var.admin_username
  mail_from_address = var.mail_from_address
  mail_source_arn   = var.mail_source_arn
  tags              = local.tags
}

# Fetch the Cognito JWKS at Terraform apply time (this runner has internet access).
# The JSON is baked into the Lambda as BIFFO_COGNITO_JWKS_JSON so the function
# can verify JWTs without any outbound call — no Cognito VPC endpoint or NAT needed.
# If Cognito rotates signing keys, run `terraform apply` to refresh this value.
data "http" "cognito_jwks" {
  url = "https://cognito-idp.${var.aws_region}.amazonaws.com/${module.auth.user_pool_id}/.well-known/jwks.json"
}

module "events" {
  source = "../../../modules/cloud/aws/events"

  project_name          = var.project_name
  environment           = local.environment
  cloudwatch_kms_key_id = aws_kms_key.logs.arn
  tags                  = local.tags
}

module "database" {
  source = "../../../modules/cloud/aws/database"

  project_name              = var.project_name
  environment               = local.environment
  vpc_id                    = module.networking.vpc_id
  private_subnet_ids        = module.networking.private_subnet_ids
  compute_security_group_id = module.core_api.security_group_id
  instance_class            = "db.t3.micro"
  multi_az                  = false
  deletion_protection       = false
  enable_rds_proxy          = false # saves ~$22/month; Lambda connects to RDS directly
  tags                      = local.tags
}

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
  # the signer is provisioned.
  #
  # The Core -> agent-runtime sync-invoke grant (ADR-0016) is deliberately NOT
  # here: it lives in the template-owned plugins.core.tf as a standalone
  # aws_iam_role_policy on this role, so it rides `biffo core upgrade` instead of
  # depending on a hand-edit of this user-owned file. Core derives the runtime's
  # function name by convention (services/api config.py), not from an env var set
  # here.
  invoke_function_arns = var.enable_pr_signer ? [module.pr_signer[0].function_arn] : []
  environment_variables = {
    BIFFO_ENVIRONMENT = local.environment
    # Name of the PR-signer Lambda to invoke for endpoint permission changes
    # (ADR-0008). Empty when the signer isn't provisioned; the Core API treats
    # an empty value as "endpoint control plane not configured".
    BIFFO_PR_SIGNER_FUNCTION_NAME = var.enable_pr_signer ? module.pr_signer[0].function_name : ""
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
  }
  tags = local.tags
}

module "api_gateway" {
  source = "../../../modules/cloud/aws/api-gateway"

  project_name          = var.project_name
  environment           = local.environment
  lambda_function_arn   = module.core_api.function_arn
  lambda_function_name  = module.core_api.function_name
  cognito_user_pool_id  = module.auth.user_pool_id
  cognito_client_id     = module.auth.client_id
  aws_region            = var.aws_region
  cors_origins          = local.cors_origins_list
  cloudwatch_kms_key_id = aws_kms_key.logs.arn
  tags                  = local.tags
}

# ---------------------------------------------------------------------------
# Endpoint control plane — isolated PR-signer (ADR-0008)
#
# The signer is the only component that holds the GitHub App credential. The
# Core API authorizes an admin's request and invokes this function over IAM
# (see invoke_function_arns on module.core_api above); the signer edits a
# plugin's permissions block and opens a PR. Nothing goes live until that PR is
# merged through the normal pipeline — config-as-code is preserved (ADR-0004).
#
# Gated on enable_pr_signer: creating a live GitHub App is a manual setup step
# (docs/guides/endpoint-control-plane-setup.md), so the platform stands up
# without one. The App private key is uploaded to the secret below out-of-band;
# it is never stored in Terraform state.
# ---------------------------------------------------------------------------

check "pr_signer_config" {
  assert {
    condition = !var.enable_pr_signer || (
      var.pr_signer_github_app_id != "" &&
      var.pr_signer_github_installation_id != "" &&
      var.pr_signer_repo_owner != "" &&
      var.pr_signer_repo_name != ""
    )
    error_message = "enable_pr_signer requires pr_signer_github_app_id, pr_signer_github_installation_id, pr_signer_repo_owner and pr_signer_repo_name to be set."
  }
}

resource "aws_secretsmanager_secret" "pr_signer_github_app_key" {
  count                   = var.enable_pr_signer ? 1 : 0
  name                    = "/${var.project_name}/${local.environment}/pr-signer/github-app-key"
  description             = "GitHub App private key (PEM) for the endpoint control-plane PR-signer (ADR-0008). Value is uploaded out-of-band; never stored in Terraform."
  recovery_window_in_days = local.environment == "prod" ? 30 : 0
  tags                    = local.tags
}

module "pr_signer" {
  source = "../../../modules/cloud/aws/compute"
  count  = var.enable_pr_signer ? 1 : 0

  project_name          = var.project_name
  environment           = local.environment
  function_name         = "pr-signer"
  handler               = "src.pr_signer.handler.handler"
  timeout               = 30
  cloudwatch_kms_key_id = aws_kms_key.logs.arn
  # No VPC: the signer calls the public GitHub API and touches no database
  # (ADR-0002). In this NAT-less env a VPC-attached Lambda couldn't reach GitHub.
  enable_vpc_access    = false
  readable_secret_arns = [aws_secretsmanager_secret.pr_signer_github_app_key[0].arn]
  environment_variables = {
    BIFFO_ENVIRONMENT                     = local.environment
    BIFFO_PR_SIGNER_APP_ID                = var.pr_signer_github_app_id
    BIFFO_PR_SIGNER_INSTALLATION_ID       = var.pr_signer_github_installation_id
    BIFFO_PR_SIGNER_REPO_OWNER            = var.pr_signer_repo_owner
    BIFFO_PR_SIGNER_REPO_NAME             = var.pr_signer_repo_name
    BIFFO_PR_SIGNER_PRIVATE_KEY_SECRET_ID = aws_secretsmanager_secret.pr_signer_github_app_key[0].arn
    BIFFO_PR_SIGNER_BASE_BRANCH           = var.pr_signer_base_branch
  }
  tags = local.tags
}

# ---------------------------------------------------------------------------
# Plugin modules (ADR-0003 chunk 12 / issues #25, #201)
#
# There are no `module "plugin_*"` blocks in this file, and there should not
# be. Terraform requires a module's `source` to be a static string literal, so
# each installed plugin needs its own explicit block — and `biffo plugin
# install` generates them, into its own CLI-owned file:
#
#   plugins.generated.tf       one module block + one output per installed plugin
#   plugins.auto.tfvars.json   the matching `enabled_plugins` list
#
# Both are regenerated in full from the contents of modules/plugins/ on every
# install and uninstall, so they are idempotent by construction. Terraform
# loads every *.tf file in this directory, so those blocks are exactly as live
# as anything written here.
#
# The CLI never edits this file. infra/ is user-owned (core-manifest.json), and
# a generator that appends to or re-emits a hand-authored main.tf owns bytes a
# human is also editing. Keeping the generated blocks in a separate file means
# the two never contend.
#
# What this file DOES own for plugins is the ADR-0009 allowlist HOOK — the
# module "plugin_allowlist" block above and BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST
# on module.core_api. The derivation itself lives in
# modules/cloud/aws/plugin-allowlist (template-owned, so it rides `biffo core
# upgrade`): a static role-name glob over var.enabled_plugins, never a plugin
# module's role_arn output. See that module's main.tf for the full rationale.
#
# To disable an installed plugin without uninstalling it, set enabled_plugins
# explicitly via -var/-var-file/TF_VAR_enabled_plugins — all of which outrank
# the generated *.auto.tfvars.json.
# ---------------------------------------------------------------------------

output "api_gateway_url" {
  description = "HTTP API endpoint — set as NEXT_PUBLIC_API_URL in the portal build"
  value       = module.api_gateway.api_endpoint
}

output "core_api_lambda_name" {
  description = "Core API Lambda function name — read by `biffo data apply` (ADR-0005) to invoke the biffo:ddl-import event directly"
  value       = module.core_api.function_name
}

output "pr_signer_lambda_name" {
  description = "PR-signer Lambda function name (ADR-0008), or null when enable_pr_signer is false. The Core API invokes this to open endpoint permission-change PRs."
  value       = var.enable_pr_signer ? module.pr_signer[0].function_name : null
}

output "portal_url" {
  value = local.portal_url
}

output "portal_bucket_name" {
  value = module.storage.portal_bucket_name
}

output "cloudfront_distribution_id" {
  value = module.cdn.distribution_id
}

output "cloudfront_distribution_domain" {
  value = module.cdn.distribution_domain
}

output "cognito_user_pool_id" {
  value = module.auth.user_pool_id
}

output "cognito_client_id" {
  value = module.auth.client_id
}

output "enabled_plugins" {
  description = "Plugin names this deploy was configured with. Aggregate per-plugin outputs (e.g. Lambda ARNs) here as module \"plugin_<name>\" blocks are added — see the \"Plugin modules\" section above."
  value       = var.enabled_plugins
}
