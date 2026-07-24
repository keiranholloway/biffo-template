# Egress posture: managed NAT gateway (the module default).
#
# Each posture lives in its own *.tftest.hcl file so it gets an isolated state.
# mock_provider treats a resource's computed nested `route` set as sticky, so
# running the postures as sequential run blocks in one shared-state file leaks a
# prior posture's route into the next; separate files keep assertions clean.
#
# mock_provider means no AWS credentials or network access: the aws provider's
# data sources and computed attributes are filled with generated values, so
# `command = apply` yields a fully-known plan. aws_flow_log validates that its
# iam_role_arn / log_destination are real ARNs, so those two are given valid
# mock ARNs (canonical placeholder account id). AZs are passed explicitly so
# subnet counts are deterministic without the aws_availability_zones data source.

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

run "nat_gateway_posture" {
  command = apply

  # defaults: enable_nat_gateway = true, single_nat_gateway = true

  assert {
    condition     = length(aws_nat_gateway.main) == 1
    error_message = "expected a single managed NAT gateway"
  }

  assert {
    condition     = length(aws_instance.nat) == 0
    error_message = "no NAT instance should exist under the NAT gateway posture"
  }

  # Interface endpoints are dropped whenever there is private egress.
  assert {
    condition     = length(aws_vpc_endpoint.cognito_idp) == 0 && length(aws_vpc_endpoint.secretsmanager) == 0 && length(aws_vpc_endpoint.events) == 0
    error_message = "billed interface endpoints must be absent when a NAT provides egress"
  }

  # S3 gateway endpoint is always present (free), regardless of posture.
  assert {
    condition     = length(aws_vpc_endpoint.s3) == 1
    error_message = "the free S3 gateway endpoint should always be created"
  }

  assert {
    condition     = anytrue([for r in aws_route_table.private[0].route : r.nat_gateway_id != ""])
    error_message = "private route table should route 0.0.0.0/0 via the NAT gateway"
  }
}
