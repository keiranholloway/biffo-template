terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }

  backend "s3" {
    # Populated at init time: terraform init -backend-config=backend.hcl
    # See scripts/bootstrap.sh for setup
  }
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
}

module "networking" {
  source = "../../../modules/cloud/aws/networking"

  project_name       = var.project_name
  environment        = local.environment
  single_nat_gateway = true # cost saving for dev
  tags               = local.tags
}

module "storage" {
  source = "../../../modules/cloud/aws/storage"

  project_name      = var.project_name
  environment       = local.environment
  cloudfront_oac_id = module.cdn.oac_id
  tags              = local.tags
}

module "cdn" {
  source = "../../../modules/cloud/aws/cdn"

  project_name                  = var.project_name
  environment                   = local.environment
  portal_bucket_regional_domain = module.storage.portal_bucket_regional_domain
  portal_bucket_name            = module.storage.portal_bucket_name
  tags                          = local.tags
}

module "auth" {
  source = "../../../modules/cloud/aws/auth"

  project_name   = var.project_name
  environment    = local.environment
  domain_prefix  = "${var.project_name}-dev"
  admin_email    = var.admin_email
  admin_username = var.admin_username
  tags           = local.tags
}

module "events" {
  source = "../../../modules/cloud/aws/events"

  project_name = var.project_name
  environment  = local.environment
  tags         = local.tags
}

module "core_api" {
  source = "../../../modules/cloud/aws/compute"

  project_name               = var.project_name
  environment                = local.environment
  function_name              = "core-api"
  handler                    = "src.api.main.lambda_handler"
  vpc_id                     = module.networking.vpc_id
  private_subnet_ids         = module.networking.private_subnet_ids
  db_credentials_secret_arn  = module.database.credentials_secret_arn
  event_bus_name             = module.events.event_bus_name
  environment_variables = {
    BIFFO_ENVIRONMENT         = local.environment
    BIFFO_EVENT_BUS_NAME      = module.events.event_bus_name
    BIFFO_COGNITO_USER_POOL_ID = module.auth.user_pool_id
    BIFFO_COGNITO_CLIENT_ID    = module.auth.client_id
    BIFFO_COGNITO_REGION       = var.aws_region
  }
  tags = local.tags
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
  tags                      = local.tags
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
  cors_origins         = ["https://${module.cdn.distribution_domain}"]
  tags                 = local.tags
}

output "api_gateway_url" {
  description = "HTTP API endpoint — set as NEXT_PUBLIC_API_URL in the portal build"
  value       = module.api_gateway.api_endpoint
}

output "portal_url" {
  value = "https://${module.cdn.distribution_domain}"
}

output "cognito_user_pool_id" {
  value = module.auth.user_pool_id
}

output "cognito_client_id" {
  value = module.auth.client_id
}
