# Fail-first evidence for the CDN path contract guard (biffo-template#1923).
#
# aws_cloudfront_distribution.portal's lifecycle.precondition fails the plan
# closed when a behaviour this instance's configuration wants active has no
# row in the CDN path contract (path-contract.json), or when the contract
# carries a row keyed by something this module has no wiring for at all. The
# fixtures under tests/fixtures/ are deliberately broken copies of the real
# contract, injected via the test-only path_contract_file variable (see its
# description in variables.tf) so these runs exercise the real guard logic
# without mutating the committed contract.

mock_provider "aws" {}

variables {
  project_name                  = "test-proj"
  environment                   = "test"
  portal_bucket_regional_domain = "test-proj-test-portal.s3.eu-west-1.amazonaws.com"
  portal_bucket_name            = "test-proj-test-portal"
  portal_bucket_id              = "test-proj-test-portal"
  portal_bucket_arn             = "arn:aws:s3:::test-proj-test-portal"
}

# Baseline: the real, committed contract, with every optional feature turned
# on so all 8 rows are active at once. This must plan clean — the guard must
# never fire a false positive over its own correctly-generated output.
run "real_contract_with_every_feature_enabled_plans_clean" {
  command = plan

  variables {
    plugin_host_api_domain  = "plugins.example.com"
    core_api_health_domain  = "api.example.com"
    tracked_link_api_domain = "api.example.com"
  }

  assert {
    condition     = length(local.path_contract_missing_rows) == 0
    error_message = "the real contract must not report any missing rows when every feature is enabled"
  }

  assert {
    condition     = length(local.path_contract_orphan_rows) == 0
    error_message = "the real contract must not report any orphan rows"
  }

  assert {
    condition     = local.path_contract_pattern["click"] == "c/*"
    error_message = "the click behaviour's path pattern should resolve straight from the contract row"
  }

  assert {
    condition     = strcontains(aws_cloudfront_function.click_rewrite[0].code, "'/api/v1/public' + request.uri")
    error_message = "the generated click-rewrite function code should splice in the contract row's origin_path_prefix"
  }
}

# RED: enabling the tracked-link feature (which wants the "click" behaviour)
# against a contract fixture with the "click" row deleted must fail the plan
# closed, naming the gap -- direction 1 of the guard.
run "missing_contract_row_for_an_active_behaviour_fails_closed" {
  command = plan

  variables {
    path_contract_file      = "tests/fixtures/path-contract-missing-click.json"
    tracked_link_api_domain = "api.example.com"
  }

  expect_failures = [
    aws_cloudfront_distribution.portal,
  ]
}

# GREEN counterpart to the run above: same broken fixture, but the
# tracked-link feature stays OFF, so "click" is never gated on and its
# absence from the contract is not a defect. Proves the guard distinguishes
# "row missing for a feature that's off" (fine) from "row missing for a
# feature that's on" (the run above).
run "missing_contract_row_for_an_inactive_behaviour_plans_clean" {
  command = plan

  variables {
    path_contract_file = "tests/fixtures/path-contract-missing-click.json"
  }

  assert {
    condition     = length(local.path_contract_missing_rows) == 0
    error_message = "a contract row missing for a feature that is OFF must not trip the guard"
  }
}

# RED: a contract fixture carrying an extra row ("webhooks") that no key in
# path_contract_gate recognises must fail the plan closed, naming the
# orphan -- direction 2 of the guard.
run "orphan_contract_row_fails_closed" {
  command = plan

  variables {
    path_contract_file = "tests/fixtures/path-contract-orphan-row.json"
  }

  expect_failures = [
    aws_cloudfront_distribution.portal,
  ]
}

# RED: a contract fixture where the "click" row's path_pattern ("clicks/*")
# disagrees with main.tf's own hard-coded literal ("c/*") must fail the plan
# closed -- direction 3 of the guard (path_contract_value_mismatches). This
# fires regardless of whether tracked_link_api_domain is set: the mismatch
# check compares the contract row's value against main.tf's hard-coded
# literal unconditionally, not only when the feature is active, because an
# instance with the feature OFF today can still turn it on tomorrow against
# an already-wrong contract.
run "value_mismatch_against_main_tf_hardcoded_literal_fails_closed" {
  command = plan

  variables {
    path_contract_file = "tests/fixtures/path-contract-value-mismatch.json"
  }

  expect_failures = [
    aws_cloudfront_distribution.portal,
  ]
}
