# Instance-shaped wiring under mock providers: mail_source_arn comes from a
# resource attribute and a plugin-style module takes module.api_gateway's
# execution_arn, as in tabsii-platform. Both are computed (unknown) at plan
# time under mocks, so a `count` keyed on them fails with "Invalid count
# argument" unless the test replaces the modules supplying them. This is the
# same override the dev-root test uses, so an instance with this wiring runs
# the template's tests unchanged. TEMPLATE-OWNED (see core-manifest.json).

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    defaults = { name = "us-east-1" }
  }
}

run "computed_values_into_count_inputs_plan" {
  command = plan

  module {
    source = "./tests/instance_shape"
  }

  override_module {
    target = module.auth
    outputs = {
      user_pool_id     = "us-east-1_mock"
      user_pool_arn    = "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_mock"
      client_id        = "mockclientid"
      hosted_ui_domain = "mock.auth.us-east-1.amazoncognito.com"
    }
  }

  override_module {
    target = module.api_gateway
    outputs = {
      execution_arn = "arn:aws:execute-api:us-east-1:123456789012:mockapi"
      api_endpoint  = "https://mockapi.execute-api.us-east-1.amazonaws.com"
    }
  }

  assert {
    condition     = output.user_pool_id == "us-east-1_mock"
    error_message = "The instance-shaped wiring must plan under mock providers."
  }
}
