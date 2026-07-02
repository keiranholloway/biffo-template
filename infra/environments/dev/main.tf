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

module "networking" {
  source = "../../../modules/cloud/aws/networking"

  project_name       = var.project_name
  environment        = local.environment
  enable_nat_gateway = false # no NAT Gateway — saves ~$33/month; see JWKS/DB approach below
  single_nat_gateway = true  # irrelevant when enable_nat_gateway = false, kept for explicitness
  tags               = local.tags
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

  project_name = var.project_name
  environment  = local.environment
  tags         = local.tags
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

  project_name  = var.project_name
  environment   = local.environment
  function_name = "core-api"
  handler       = "src.api.main.lambda_handler"
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
  event_bus_name            = module.events.event_bus_name
  environment_variables = {
    BIFFO_ENVIRONMENT = local.environment
    # Full DB URL baked in — Lambda has no outbound internet so it can't call
    # Secrets Manager. db_url is sensitive and stored in Terraform state.
    BIFFO_DATABASE_URL         = module.database.db_url
    BIFFO_COGNITO_JWKS_JSON    = data.http.cognito_jwks.response_body
    BIFFO_COGNITO_USER_POOL_ID = module.auth.user_pool_id
    BIFFO_COGNITO_CLIENT_ID    = module.auth.client_id
    BIFFO_COGNITO_REGION       = var.aws_region
    BIFFO_EVENT_BUS_NAME       = module.events.event_bus_name
    BIFFO_CORS_ORIGINS         = local.cors_origins
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

  project_name         = var.project_name
  environment          = local.environment
  lambda_function_arn  = module.core_api.function_arn
  lambda_function_name = module.core_api.function_name
  cognito_user_pool_id = module.auth.user_pool_id
  cognito_client_id    = module.auth.client_id
  aws_region           = var.aws_region
  cors_origins         = local.cors_origins_list
  tags                 = local.tags
}

# ---------------------------------------------------------------------------
# Plugin modules (ADR-0003 chunk 12 / issue #25)
#
# Terraform requires a module's `source` argument to be a static string
# literal — it cannot be built from `var.enabled_plugins` at runtime, so this
# root config cannot loop over an arbitrary plugin list with one generic
# module block. Instead, each installed plugin gets its own explicit
# `module "plugin_<name>"` block below, individually gated on membership in
# `enabled_plugins` via `for_each`. `biffo plugin install <name>@<minor>`
# (issue #20/ADR-0003 chunk 7) copies the plugin's own terraform/ directory
# into modules/plugins/<name>/ — once that directory exists, add a block
# following this exact shape (copy-paste and replace <name>):
#
#   module "plugin_<name>" {
#     source   = "../../../modules/plugins/<name>"
#     for_each = contains(var.enabled_plugins, "<name>") ? { "<name>" = true } : {}
#
#     project_name   = var.project_name
#     environment    = local.environment
#     plugin_name    = "<name>"
#     handler        = "src.lambda.main.handler"
#     event_bus_name = module.events.event_bus_name
#     core_api_url   = module.api_gateway.api_endpoint
#     tags           = local.tags
#   }
#
# No block references `vpc_id`/`private_subnet_ids` or
# `db_credentials_secret_arn` by default — per ADR-0002, plugins reach
# platform data through the Core API (`core_api_url`) and react to
# `event_bus_name`, never the database directly. See
# modules/plugins/_template/README.md for the full variable contract, and
# infra/environments/dev/README.md for the end-to-end "adding a plugin"
# walkthrough, including how to aggregate each plugin's outputs (e.g.
# `module.plugin_<name>[<name>].function_arn`) into the outputs below.
#
# No plugin module directory exists in this checkout yet (no plugin has
# shipped a terraform/ directory — see modules/plugins/_template/README.md),
# so there are currently no live `module "plugin_*"` blocks here. Keep the
# root backend/provider configuration above and the module blocks below
# untouched when adding one — only append new `module "plugin_<name>"`
# blocks and their corresponding output entries.
# ---------------------------------------------------------------------------

output "api_gateway_url" {
  description = "HTTP API endpoint — set as NEXT_PUBLIC_API_URL in the portal build"
  value       = module.api_gateway.api_endpoint
}

output "core_api_lambda_name" {
  description = "Core API Lambda function name — read by `biffo data apply` (ADR-0005) to invoke the biffo:ddl-import event directly"
  value       = module.core_api.function_name
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
