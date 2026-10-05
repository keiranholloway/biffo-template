# Instance knobs for the template-owned module "core_api" (core-api.core.tf),
# exercised at ENVIRONMENT level so the real merge() wiring is under test, not
# a compute-module stand-in. TEMPLATE-OWNED (see core-manifest.json).
#
# Scenario 1 — an instance with no overrides gets the template's behaviour.
# Scenario 2 — an instance setting a raised memory size, warm capacity and
# two extra environment variables gets exactly those, and the template keys
# survive the merge.
#
# local.core_api_instance_environment lives in the user-owned core-api.instance.tf
# and cannot be set from a test, so the env-var scenarios use
# var.core_api_extra_environment, which is merged right after it in the same
# merge() call (core-api.core.tf).

mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:mock" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = { arn = "arn:aws:sqs:us-east-1:123456789012:mock-dlq" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:us-east-1:123456789012:key/mock" }
  }
  mock_resource "aws_lambda_code_signing_config" {
    defaults = { arn = "arn:aws:lambda:us-east-1:123456789012:code-signing-config:csc-mock" }
  }
  mock_resource "aws_signer_signing_profile" {
    defaults = {
      version_arn = "arn:aws:signer:us-east-1:123456789012:/signing-profiles/mock/versions/1"
    }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b", "us-east-1c"] }
  }
  mock_data "aws_region" {
    defaults = { name = "us-east-1" }
  }
}

mock_provider "http" {
  mock_data "http" {
    defaults = { response_body = "{}" }
  }
}

mock_provider "random" {}

variables {
  project_name   = "knobs-test"
  admin_email    = "admin@example.com"
  admin_username = "admin"
  # Not under test; avoids plugin modules that need api_gateway outputs at plan time.
  enable_core_plugins = false
}

# Count/for_each arguments in the modules read the shared log key's computed ARN,
# which is unknown until that key exists (the same reason a real first apply is
# staged). Create just that key first so every later run plans against a
# resolved ARN, as an instance with an existing state does.
run "bootstrap_shared_log_key" {
  command = apply

  plan_options {
    target = [aws_kms_key.logs]
  }
}

run "no_overrides_keeps_template_behaviour" {
  command = plan

  assert {
    condition     = module.core_api.memory_size == 512
    error_message = "Default memory must stay the compute module's 512 MB."
  }

  assert {
    condition     = module.core_api.timeout == 300
    error_message = "Default timeout must stay 300s."
  }

  assert {
    condition     = module.core_api.snap_start_enabled == false
    error_message = "Warm capacity (SnapStart) must be off by default."
  }

  assert {
    condition     = !contains(keys(module.core_api.environment_variables), "BIFFO_DB_SEARCH_PATH") && !contains(keys(module.core_api.environment_variables), "BIFFO_SIMULATION_PERSONAS_PARAMETER_PATH")
    error_message = "No instance keys may appear without an override."
  }

  assert {
    condition     = contains(keys(module.core_api.environment_variables), "BIFFO_ENVIRONMENT")
    error_message = "Template environment keys must be present."
  }
}

run "overrides_change_exactly_the_knobs" {
  command = plan

  variables {
    core_api_memory_size          = 1024
    core_api_enable_warm_capacity = true
    core_api_extra_environment = {
      BIFFO_DB_SEARCH_PATH                     = "public,tabsii"
      BIFFO_SIMULATION_PERSONAS_PARAMETER_PATH = "/tabsii/dev/personas"
    }
  }

  assert {
    condition     = module.core_api.memory_size == 1024
    error_message = "core_api_memory_size must reach the Lambda."
  }

  assert {
    condition     = module.core_api.snap_start_enabled == true
    error_message = "core_api_enable_warm_capacity must attach SnapStart."
  }

  assert {
    condition     = module.core_api.timeout == 300
    error_message = "An untouched knob must keep its default."
  }

  assert {
    condition     = module.core_api.environment_variables["BIFFO_DB_SEARCH_PATH"] == "public,tabsii" && module.core_api.environment_variables["BIFFO_SIMULATION_PERSONAS_PARAMETER_PATH"] == "/tabsii/dev/personas"
    error_message = "Instance environment variables must be merged into the Lambda."
  }

  assert {
    condition     = module.core_api.environment_variables["BIFFO_PLUGIN_SERVICES_ROOT"] == "/var/task/services"
    error_message = "Template keys must survive the instance merge."
  }
}

run "instance_environment_wins_last" {
  command = plan

  variables {
    core_api_extra_environment = { BIFFO_PLUGIN_SERVICES_ROOT = "/override" }
  }

  assert {
    condition     = module.core_api.environment_variables["BIFFO_PLUGIN_SERVICES_ROOT"] == "/override"
    error_message = "The instance extension is merged last and must win."
  }
}
