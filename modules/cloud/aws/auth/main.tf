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

  # Sign in with the username OR the email address (issue #276).
  #
  # `auto_verified_attributes` below only causes the email to be *verified*; it
  # does not make it a login identifier. Without this, the only accepted
  # identifier is the literal username — so an admin created as `admin` with
  # keiran@example.com attached could not sign in with their email address, and
  # Cognito reported it as "Incorrect username or password" rather than as an
  # unsupported identifier. The portal's login field offers "Username or email",
  # which was a promise the pool could not keep.
  #
  # WARNING — changing this on an existing pool forces REPLACEMENT of the pool
  # and destroys every user in it. Cognito cannot migrate users between pools
  # with their passwords intact, so every user must re-register or be re-invited.
  # Any table keyed on `cognito_sub` (see ADR-0012) is orphaned by the change.
  # Deliberately accepted here while instances have only a handful of users.
  alias_attributes = ["email"]

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

  # Customize the sender identity when a SES identity
  # is provided via vars. Without these vars the pool keeps Cognito's default
  # no-reply@verificationemail.com sender.
  dynamic "email_configuration" {
    for_each = local.custom_sender_set ? [1] : []
    content {
      email_sending_account = "DEVELOPER"
      source_arn            = var.mail_source_arn
      from_email_address    = var.mail_from_address
    }
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

  # Feature tier. Advanced security (threat protection) requires the Plus tier,
  # and AWS disables cognito-idp VPC endpoints (PrivateLink) for Essentials/Plus
  # pools ("PrivateLink access is disabled for the user pool that has ManagedLogin
  # configured"). dev is NAT-less and reaches Cognito's admin API through that VPC
  # endpoint, so dev must stay on the Lite tier or user-management calls fail.
  # staging/prod have NAT (Cognito egresses normally), so they keep Plus +
  # threat protection. The domain's managed_login_version is unrelated to this.
  user_pool_tier = var.environment == "dev" ? "LITE" : "PLUS"

  dynamic "user_pool_add_ons" {
    # Lite has no advanced security; omit the block entirely on dev.
    for_each = var.environment == "dev" ? [] : [1]
    content {
      advanced_security_mode = var.environment == "prod" ? "ENFORCED" : "AUDIT"
    }
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

# Hosted-UI / managed-login domain. AWS disables cognito-idp VPC endpoints
# (PrivateLink) for ANY pool that has a domain configured. dev is NAT-less and
# reaches Cognito's admin API through that VPC endpoint (for user management),
# so a dev pool MUST NOT have a domain — otherwise those calls fail with
# "PrivateLink access is disabled for the user pool that has ManagedLogin
# configured". The portal signs in via SRP (amazon-cognito-identity-js) and JWKS
# is fetched by pool id, so the hosted UI is unused anyway; dev simply omits it.
# staging/prod have NAT (Cognito egresses normally, no endpoint), so they keep
# the domain for any hosted-UI/OAuth use. managed_login_version = 1 pins classic.
resource "aws_cognito_user_pool_domain" "main" {
  count                 = var.environment == "dev" ? 0 : 1
  domain                = var.domain_prefix
  user_pool_id          = aws_cognito_user_pool.main.id
  managed_login_version = 1
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

# Baseline authorization groups. Group membership is the source of truth for
# authorization: the Core API reads the `cognito:groups` JWT claim into the
# caller's roles and matches it against declarative table/route permissions
# (ADR-0004). Authorization is a core concern (ADR-0011): these baseline groups
# are the seed of it. Lower precedence wins when a user is in multiple groups.
locals {
  cognito_groups = {
    admin  = { precedence = 1, description = "Full administrative access, including user management." }
    editor = { precedence = 5, description = "Can create and modify content." }
    viewer = { precedence = 10, description = "Read-only access. Default role for new users." }
  }
}

resource "aws_cognito_user_group" "baseline" {
  for_each = local.cognito_groups

  user_pool_id = aws_cognito_user_pool.main.id
  name         = each.key
  precedence   = each.value.precedence
  description  = each.value.description
}

# Put the seeded admin into the admin group, otherwise no principal can reach
# the admin-gated endpoints on a fresh deployment.
resource "aws_cognito_user_in_group" "admin" {
  user_pool_id = aws_cognito_user_pool.main.id
  group_name   = aws_cognito_user_group.baseline["admin"].name
  username     = aws_cognito_user.admin.username
}