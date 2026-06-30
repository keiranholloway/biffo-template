terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

locals {
  name_prefix       = "${var.project_name}-${var.environment}"
  custom_sender_set = var.mail_from_address != "" && var.mail_source_arn != ""
}

resource "aws_cognito_user_pool" "main" {
  name = local.name_prefix

  # Password policy
  password_policy {
    minimum_length                   = 12
    require_uppercase                = true
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }

  mfa_configuration = var.mfa_configuration

  software_token_mfa_configuration {
    enabled = true
  }

  # Email verification
  auto_verified_attributes = ["email"]

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your ${var.project_name} verification code"
    email_message        = "Your verification code is {####}"
  }

  # Customize the sender identity and admin invitation body when a SES identity
  # is provided via vars. Without these vars the pool keeps Cognito's default
  # no-reply@verificationemail.com sender and stock invitation template.
  dynamic "email_configuration" {
    for_each = local.custom_sender_set ? [1] : []
    content {
      email_sending_account = "DEVELOPER"
      source_arn            = var.mail_source_arn
      from_email_address    = var.mail_from_address
    }
  }

  # Invitation template for admin-created users — names the project/environment
  # so recipients know which app the password is for.
  invitation_template {
    email_message = <<-EOT
      Welcome to ${var.project_name}.

      An admin account has been created for you in the ${var.environment} environment.

      Username: {username}
      Temporary password: {####}

      Sign in with your temporary password and you will be prompted to set a new one.
    EOT
    email_subject = "Your temporary password for ${var.project_name} (${var.environment})"
    sms_message   = "Your username is {username} and temporary password is {####} for ${var.environment}."
  }

  # Multi-tenant seam: tenant_id as a custom attribute (ADR-0001)
  schema {
    name                = "tenant_id"
    attribute_data_type = "String"
    mutable             = true
    required            = false
    string_attribute_constraints {
      min_length = 1
      max_length = 64
    }
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  user_pool_add_ons {
    advanced_security_mode = var.environment == "prod" ? "ENFORCED" : "AUDIT"
  }

  tags = var.tags
}

resource "aws_cognito_user_pool_client" "portal" {
  name         = "${local.name_prefix}-portal"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_PASSWORD_AUTH",
  ]

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  prevent_user_existence_errors = "ENABLED"
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = var.domain_prefix
  user_pool_id = aws_cognito_user_pool.main.id
}

# Seed the initial admin user — Cognito emails a temporary password to admin_email.
# The admin signs in with that temp password and is immediately prompted to set a new one.
resource "aws_cognito_user" "admin" {
  user_pool_id = aws_cognito_user_pool.main.id
  username     = var.admin_username

  attributes = {
    email              = var.admin_email
    email_verified     = true
    "custom:tenant_id" = "default"
  }

  force_alias_creation = false
}
