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
  environment = "prod"
  tags        = { Project = var.project_name, Environment = local.environment }
  portal_url  = var.custom_domain != "" ? "https://${var.custom_domain}" : "https://${module.cdn.distribution_domain}"
  cors_origins = jsonencode(concat(
    var.custom_domain != "" ? ["https://${var.custom_domain}"] : [],
    ["https://${module.cdn.distribution_domain}"],
  ))
}

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
  tags                 = local.tags
}

output "api_gateway_url" { value = module.api_gateway.api_endpoint }
output "portal_url" {
  value = local.portal_url
}
output "portal_bucket_name" { value = module.storage.portal_bucket_name }
output "cloudfront_distribution_id" { value = module.cdn.distribution_id }
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
