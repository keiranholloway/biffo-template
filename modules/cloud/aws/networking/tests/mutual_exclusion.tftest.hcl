# Guard: enable_nat_gateway and enable_nat_instance are mutually exclusive.
# The nat_posture_mutually_exclusive check block (main.tf) must reject both true.

mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:mock" }
  }
}

variables {
  project_name       = "biffo"
  environment        = "test"
  vpc_cidr           = "10.0.0.0/16"
  availability_zones = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

run "gateway_and_instance_rejected" {
  command = plan

  variables {
    enable_nat_gateway  = true
    enable_nat_instance = true
  }

  expect_failures = [check.nat_posture_mutually_exclusive]
}
