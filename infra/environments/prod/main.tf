terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = var.project_name
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

locals {
  environment           = "prod"
  tags                  = { Project = var.project_name, Environment = local.environment }
  custom_domain_enabled = var.custom_domain != "" && var.acm_certificate_arn != ""
  portal_url            = local.custom_domain_enabled ? "https://${var.custom_domain}" : "https://${module.cdn.distribution_domain}"
  cors_origins_list = concat(
    local.custom_domain_enabled ? ["https://${var.custom_domain}"] : [],
    ["https://${module.cdn.distribution_domain}"],
  )
  cors_origins = jsonencode(local.cors_origins_list)

  # ADR-0009 — which IAM principals may call /api/v1/internal/* on the Core API.
  #
  # Derived from var.enabled_plugins as a STATIC role-name glob, deliberately
  # NOT from a plugin module's role_arn output: reading that output here would
  # make core_api depend on the plugin, which depends on api_gateway, which
  # depends on core_api — the dependency cycle recorded in issue #201 and in
  # modules/plugins/_template/outputs.tf.
  #
  # A static glob is sound because the role name is fully predictable from the
  # plugin's name: modules/cloud/aws/compute names every function's role
  # "<project>-<env>-<function>-role", and modules/plugins/_template names the
  # function "plugin-<name>". So enabling a plugin is what allowlists it, and
  # the two can never drift apart. The trailing /* matches the session name
  # that STS appends to an assumed-role ARN.
  #
  # Fails closed: with no plugins enabled this is [], and
  # require_service_principal accepts no service caller at all.
  plugin_service_principal_arns = [
    for name in var.enabled_plugins :
    "arn:aws:sts::${data.aws_caller_identity.current.account_id}:assumed-role/${var.project_name}-${local.environment}-plugin-${name}-role/*"
  ]
}

# Account ID for the ADR-0009 service-principal allowlist glob below.
data "aws_caller_identity" "current" {}

module "networking" {
  source             = "../../../modules/cloud/aws/networking"
  project_name       = var.project_name
  environment        = local.environment
  single_nat_gateway = false
  tags               = local.tags
}

moved {
  from = module.storage.aws_s3_bucket_policy.portal
  to   = module.cdn.aws_s3_bucket_policy.portal
}

module "storage" {
  source       = "../../../modules/cloud/aws/storage"
  project_name = var.project_name
  environment  = local.environment
  tags         = local.tags
}

module "cdn" {
  source                        = "../../../modules/cloud/aws/cdn"
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
  tags                          = local.tags
}

module "auth" {
  source            = "../../../modules/cloud/aws/auth"
  project_name      = var.project_name
  environment       = local.environment
  domain_prefix     = var.project_name
  admin_email       = var.admin_email
  admin_username    = var.admin_username
  mfa_configuration = "ON"
  mail_from_address = var.mail_from_address
  mail_source_arn   = var.mail_source_arn
  tags              = local.tags
}

module "events" {
  source       = "../../../modules/cloud/aws/events"
  project_name = var.project_name
  environment  = local.environment
  tags         = local.tags
}

module "core_api" {
  source                    = "../../../modules/cloud/aws/compute"
  project_name              = var.project_name
  environment               = local.environment
  function_name             = "core-api"
  handler                   = "src.api.main.lambda_handler"
  memory_size               = 1024
  timeout                   = 30
  enable_vpc_access         = true
  vpc_id                    = module.networking.vpc_id
  private_subnet_ids        = module.networking.private_subnet_ids
  db_credentials_secret_arn = module.database.credentials_secret_arn
  event_bus_name            = module.events.event_bus_name
  environment_variables = {
    BIFFO_ENVIRONMENT          = local.environment
    BIFFO_DB_SECRET_ARN        = module.database.credentials_secret_arn
    BIFFO_DB_HOST              = module.database.db_endpoint
    BIFFO_EVENT_BUS_NAME       = module.events.event_bus_name
    BIFFO_COGNITO_USER_POOL_ID = module.auth.user_pool_id
    BIFFO_COGNITO_CLIENT_ID    = module.auth.client_id
    BIFFO_COGNITO_REGION       = var.aws_region
    BIFFO_CORS_ORIGINS         = local.cors_origins
    # ADR-0009 — IAM principals allowed on /api/v1/internal/*. Maintained
    # automatically: `biffo plugin install` adds the plugin to enabled_plugins
    # (plugins.auto.tfvars.json) and the glob above follows. Fails closed when
    # no plugin is enabled.
    BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST = jsonencode(local.plugin_service_principal_arns)
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

module "database" {
  source                    = "../../../modules/cloud/aws/database"
  project_name              = var.project_name
  environment               = local.environment
  vpc_id                    = module.networking.vpc_id
  private_subnet_ids        = module.networking.private_subnet_ids
  compute_security_group_id = module.core_api.security_group_id
  instance_class            = "db.t3.medium"
  multi_az                  = true
  deletion_protection       = true
  backup_retention_days     = 30
  enable_rds_proxy          = true
  tags                      = local.tags
}

module "api_gateway" {
  source               = "../../../modules/cloud/aws/api-gateway"
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

output "api_gateway_url" { value = module.api_gateway.api_endpoint }
output "core_api_lambda_name" {
  description = "Core API Lambda function name — read by `biffo data apply` (ADR-0005) to invoke the biffo:ddl-import event directly"
  value       = module.core_api.function_name
}
output "portal_url" {
  value = local.portal_url
}
output "portal_bucket_name" { value = module.storage.portal_bucket_name }
output "cloudfront_distribution_id" { value = module.cdn.distribution_id }
output "cloudfront_distribution_domain" { value = module.cdn.distribution_domain }
output "cognito_user_pool_id" { value = module.auth.user_pool_id }
output "cognito_client_id" { value = module.auth.client_id }

variable "project_name" { type = string }
variable "aws_region" {
  type    = string
  default = "us-east-1"
}
variable "admin_email" { type = string }
variable "admin_username" { type = string }
variable "domain" {
  type    = string
  default = ""
}
variable "custom_domain" {
  type    = string
  default = ""
}
variable "acm_certificate_arn" {
  type    = string
  default = ""
}

variable "hosted_zone_id" {
  type    = string
  default = ""
}

variable "mail_from_address" {
  description = "Optional verified SES email address used as the From sender for Cognito admin-password emails. Leave blank to use Cognito's default sender."
  type        = string
  default     = ""
}

variable "mail_source_arn" {
  description = "ARN of the SES identity for mail_from_address. Required when mail_from_address is set."
  type        = string
  default     = ""
}

variable "sibling_origins" {
  description = "Sibling microservices (ADR-0007) registered for path-based routing on this project's CloudFront distribution. Populated via infra/environments/<env>/siblings.auto.tfvars.json, written by biffo sibling create's registration step — not hand-edited."
  type = list(object({
    name                   = string
    bucket_regional_domain = string
  }))
  default = []

  validation {
    condition     = length(var.sibling_origins) == length(distinct([for s in var.sibling_origins : s.name]))
    error_message = "sibling_origins must not contain duplicate sibling names."
  }

  validation {
    condition     = alltrue([for s in var.sibling_origins : can(regex("^[a-z][a-z0-9-]*$", s.name))])
    error_message = "sibling_origins names must be lowercase alphanumeric with hyphens (matching the baseurl.com/<name>/ path segment)."
  }
}

variable "enabled_plugins" {
  description = <<-EOT
    Plugin names to instantiate this deploy. Each name must have a matching
    Terraform module at modules/plugins/<name>/ — `biffo plugin install <name>@<minor>`
    (ADR-0003 chunk 7) copies a plugin's terraform/ directory there. Adding a
    name here and running `terraform apply` provisions that plugin's compute
    and event infrastructure; removing a name tears it down.

    Example: ["orchestrator"]
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.enabled_plugins) == length(distinct(var.enabled_plugins))
    error_message = "enabled_plugins must not contain duplicate plugin names."
  }

  validation {
    condition     = alltrue([for name in var.enabled_plugins : can(regex("^[a-z][a-z0-9-]*$", name))])
    error_message = "enabled_plugins names must be lowercase alphanumeric with hyphens (matching a services/<name>/ and modules/plugins/<name>/ directory name)."
  }
}
