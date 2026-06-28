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
}

module "networking" {
  source             = "../../../modules/cloud/aws/networking"
  project_name       = var.project_name
  environment        = local.environment
  single_nat_gateway = false
  tags               = local.tags
}

module "storage" {
  source            = "../../../modules/cloud/aws/storage"
  project_name      = var.project_name
  environment       = local.environment
  cloudfront_oac_id = module.cdn.oac_id
  tags              = local.tags
}

module "cdn" {
  source                        = "../../../modules/cloud/aws/cdn"
  project_name                  = var.project_name
  environment                   = local.environment
  portal_bucket_regional_domain = module.storage.portal_bucket_regional_domain
  portal_bucket_name            = module.storage.portal_bucket_name
  custom_domain                 = var.custom_domain
  acm_certificate_arn           = var.acm_certificate_arn
  tags                          = local.tags
}

module "auth" {
  source             = "../../../modules/cloud/aws/auth"
  project_name       = var.project_name
  environment        = local.environment
  domain_prefix      = var.project_name
  admin_email        = var.admin_email
  admin_username     = var.admin_username
  mfa_configuration  = "ON"
  tags               = local.tags
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
  tags                      = local.tags
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
  tags                      = local.tags
}

variable "project_name" { type = string }
variable "aws_region" { type = string, default = "us-east-1" }
variable "admin_email" { type = string }
variable "admin_username" { type = string }
variable "custom_domain" { type = string, default = "" }
variable "acm_certificate_arn" { type = string, default = "" }
