# Fail-first evidence for the plan-time SES detector (issue #1475).
#
# Uses a fully mocked aws provider (Terraform's native test framework) so
# these prove the detector's LOGIC without touching real AWS — the module
# itself never creates an SES identity, so nothing here tests SES creation,
# only that the consumed-ARN check fires (or stays silent) correctly.

mock_provider "aws" {}

variables {
  project_name  = "test-proj"
  environment   = "dev"
  domain_prefix = "test-proj-dev"
  admin_email   = "admin@example.com"
}

# Case 3 (the one that matters most): no SES configured at all — this is
# biffo-platform today. The data source must not even be attempted.
run "no_ses_configured_plans_cleanly" {
  command = plan

  assert {
    condition     = local.custom_sender_set == false
    error_message = "custom_sender_set should be false when mail_from_address/mail_source_arn are left at their default"
  }

  assert {
    condition     = length(data.aws_sesv2_email_identity.custom_sender) == 0
    error_message = "the detector data source must not be instantiated when no SES sender is configured"
  }
}

# Case 1: an instance declares mail_source_arn but the identity is not
# verified for sending. The postcondition must fail the plan.
run "unverified_identity_fails_plan" {
  command = plan

  variables {
    mail_from_address = "admin-dev@mail.example.com"
    mail_source_arn   = "arn:aws:ses:eu-west-1:123456789012:identity/mail.example.com"
  }

  override_data {
    target = data.aws_sesv2_email_identity.custom_sender[0]
    values = {
      verified_for_sending_status = false
      arn                         = "arn:aws:ses:eu-west-1:123456789012:identity/mail.example.com"
      identity_type               = "DOMAIN"
    }
  }

  expect_failures = [
    data.aws_sesv2_email_identity.custom_sender[0],
  ]
}

# Case 2: an instance declares mail_source_arn and the identity IS verified.
# The plan must go through clean.
run "verified_identity_plans_cleanly" {
  command = plan

  variables {
    mail_from_address = "admin-dev@mail.example.com"
    mail_source_arn   = "arn:aws:ses:eu-west-1:123456789012:identity/mail.example.com"
  }

  override_data {
    target = data.aws_sesv2_email_identity.custom_sender[0]
    values = {
      verified_for_sending_status = true
      arn                         = "arn:aws:ses:eu-west-1:123456789012:identity/mail.example.com"
      identity_type               = "DOMAIN"
    }
  }

  assert {
    condition     = data.aws_sesv2_email_identity.custom_sender[0].verified_for_sending_status == true
    error_message = "expected the mocked identity to read as verified"
  }
}
