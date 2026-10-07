# Fixture for instance_shape.tftest.hcl: the wiring a real instance (e.g.
# tabsii-platform) has and the template's own dev root does not -- COMPUTED
# values flowing into inputs that drive a `count`.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

variable "project_name" {
  type    = string
  default = "shape-test"
}

resource "aws_sesv2_email_identity" "domain" {
  email_identity = "mail.example.com"
}

module "auth" {
  source = "../../../../../modules/cloud/aws/auth"

  project_name      = var.project_name
  environment       = "dev"
  domain_prefix     = "${var.project_name}-dev"
  admin_email       = "admin@example.com"
  admin_username    = "admin"
  mail_from_address = "no-reply@mail.example.com"
  mail_source_arn   = aws_sesv2_email_identity.domain.arn # computed
}

module "api_gateway" {
  source = "./api_gateway_stub"
}

# Plugin-style module: count keyed on the (computed) execution ARN.
module "plugin_marketing" {
  source = "../../../../../modules/plugins/_template"

  project_name           = var.project_name
  environment            = "dev"
  plugin_name            = "marketing"
  handler                = "marketing.main.handler"
  event_bus_name         = "mock-bus"
  core_api_url           = module.api_gateway.api_endpoint
  core_api_execution_arn = module.api_gateway.execution_arn
}

output "user_pool_id" { value = module.auth.user_pool_id }
output "plugin_role_arn" { value = module.plugin_marketing.role_arn }
