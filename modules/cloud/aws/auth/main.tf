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

  # The email address IS the identity. There is no separate username anywhere in
  # the product — not in the invite email, not on the sign-in form, not in the
  # admin console.
  #
  # This replaces `alias_attributes = ["email"]`, which made the username and the
  # email two different things that had to agree. That split leaked everywhere:
  # the sign-in field had to offer "Username or email", the invite email had to
  # explain "this is your username, not your email address", and the admin
  # create-user API defaulted the username to the email — which an email-alias
  # pool rejects outright ("Username cannot be of email format"). Every one of
  # those is a symptom of asking the same question twice.
  #
  # It also makes one person one account. With an email *alias*, a federated
  # sign-in (Google) that carries an already-registered address creates a SECOND
  # profile with its own `sub`, and Cognito moves the email alias to it —
  # silently leaving the original user unable to sign in with their own address
  # (see the pre sign-up trigger docs). As a username *attribute* the address is
  # unique pool-wide, so that collision surfaces instead of corrupting an
  # identity. Linking a federated identity to an existing user still requires
  # AdminLinkProviderForUser in a pre sign-up trigger; the difference is that
  # forgetting it now fails loudly.
  #
  # Note Cognito still keeps an internal username: with username_attributes it
  # GENERATES one (a UUID equal to `sub`) and ignores any value you pass to
  # AdminCreateUser. That id is an implementation detail — every admin API also
  # accepts the email address in its place, so nothing needs to surface it. In
  # particular the invite template must NOT use `{username}`, which would render
  # that UUID.
  #
  # WARNING — changing this on an existing pool forces REPLACEMENT of the pool
  # and destroys every user in it. Cognito cannot migrate users between pools
  # with their passwords intact, so every user must re-register or be re-invited.
  # Any table keyed on `cognito_sub` (see ADR-0012) is orphaned by the change.
  # Instances upgrading past this version MUST expect to re-invite their users;
  # see the release note.
  username_attributes = ["email"]

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

  # The one-time code email. Cognito sends these as HTML, so the code sits on its
  # own labelled line inside <code>/<b> with whitespace around it — nobody should
  # have to guess whether an adjacent character (a stray leading ".", a client's
  # punctuation) is part of the code (issue #350). Only {####} is supported here
  # (no {username}).
  #
  # ## This ONE template serves several different flows, so it must not name one
  #
  # Cognito uses `verification_message_template` for sign-up confirmation,
  # attribute verification AND forgot-password. There is no way to vary the copy
  # per flow without a `CustomMessage` Lambda trigger switching on
  # `triggerSource`, and none is configured.
  #
  # It previously read "Here is your <project> password-reset code […] open your
  # <project> admin portal, choose Forgot password?" — written for #338, when the
  # only flow was a founder resetting their own password. The marketplace has
  # since added PUBLIC self-service buyer sign-up on this same pool, so a member
  # of the public registering an account was told to open an admin portal they
  # have no access to and complete a reset they never started. Reported from a
  # real registration on 2026-08-11.
  #
  # So the copy names the CODE and not the journey. It is deliberately true of
  # every flow that can send it, which is the only thing one shared template can
  # be. Per-flow wording needs the CustomMessage trigger — a bigger change, and
  # the right one if this is ever worth doing properly.
  #
  # The closing line is not filler: an unsolicited code email should say what to
  # do about it, and someone who did not ask for one has been told something.
  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your ${var.project_name} verification code"
    email_message        = <<-EOT
      Here is your ${var.project_name} verification code.<br><br>
      Verification code:<br>
      <b><code>{####}</code></b><br><br>
      Enter this code on the page that asked for it. The code is only the characters shown on the line above, and it expires shortly.<br><br>
      If you did not request this code, you can safely ignore this email — nothing has changed on your account.
    EOT
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

    # Welcome / invite email. Without this block Cognito sends its unstyled
    # default, which left a founder unable to tell where the temporary password
    # ended (issue #350). Cognito renders this as HTML.
    #
    # The copy leads with "the email address this message was sent to", because
    # that is the sign-in identifier under username_attributes and it needs no
    # placeholder — the message is already in that inbox.
    #
    # {username} is present only because Cognito REQUIRES it. CreateUserPool
    # rejects an invite template without it in either member:
    #   "Email message body should have {username} which will be replaced by code"
    #   "SMS message should have {username} which will be replaced by code"
    # Under username_attributes the generated username is a UUID, so this may
    # render as an opaque id rather than the address. It is therefore labelled as
    # a reference and NOT as something to type — copy that reads correctly
    # whichever value Cognito substitutes.
    #
    # sms_message is mandatory even though invites go by email: Cognito's
    # CreateUserPool validates ALL three members of inviteMessageTemplate, and
    # rejects an empty sMSMessage with InvalidParameterException ("Member must
    # have length greater than or equal to 6"), so omitting it means no pool can
    # ever be created (issue #356).
    invite_message_template {
      email_subject = "Your ${var.project_name} admin account"
      email_message = <<-EOT
        Your ${var.project_name} admin account is ready.<br><br>
        Sign in at your admin portal with <b>the email address this message was sent to</b>, and the temporary password below.<br><br>
        Temporary password:<br>
        <b><code>{####}</code></b><br><br>
        Enter it exactly as shown on its own line above, with no surrounding punctuation. On your first sign-in you will be asked to set a new password of your own.<br><br>
        <span style="color:#6b7280;font-size:12px">Account reference: {username} — for support only, you do not need to enter this.</span>
      EOT
      sms_message   = "Your ${var.project_name} admin temporary password is {####}. Sign in with your email address. (Ref {username})"
    }
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

  # The email address, not var.admin_username. The pool sets
  # username_attributes = ["email"], so Cognito requires the username to BE an
  # address and rejects anything else outright:
  #   InvalidParameterException: Username should be an email
  # That failure lands in `terraform apply` AFTER the pool has been replaced,
  # leaving a fresh pool with no administrator in it — so it is worth a guard
  # (see services/api/tests/test_email_is_the_identity.py) rather than a comment.
  username = var.admin_email

  # The custom attribute is declared WITHOUT its `custom:` prefix, and that is
  # load-bearing rather than a style choice — see
  # services/api/tests/test_cognito_user_attribute_keys.py.
  #
  # The provider strips the prefix when it reads state
  # (`flattenAttributeTypes`) but re-adds it when it writes
  # (`expandAttributeTypes` → `normalizeUserAttributeKey`). Declaring the
  # PREFIXED form here therefore made state (`tenant_id`) and config
  # (`custom:tenant_id`) permanently disagree: the diff never matched, so every
  # apply both wrote the attribute and put it in the delete list, deleting the
  # value it had just written one second earlier.
  #
  # The effect was an oscillation — roughly every other apply stripped
  # `custom:tenant_id` from the seeded admin and the next restored it. Measured
  # before the fix: 23 deletions in biffo-platform and 50+ in tabsii-platform
  # (#1476). Harmless only because nothing reads the claim today
  # (`_user_from_claims` hardcodes `tenant_id="default"`), which is exactly why
  # it went unnoticed for six weeks and why it is a trap for ADR-0001's
  # multi-tenant seam.
  attributes = {
    email          = var.admin_email
    email_verified = true
    tenant_id      = "default"
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